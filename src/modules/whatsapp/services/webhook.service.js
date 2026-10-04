import { env } from "../../../config/env.js";
import { WhatsAppWebhookEvent } from "../models/whatsappWebhookEvent.model.js";
import { WhatsAppMessage } from "../models/whatsappMessage.model.js";
import { findOrCreateContact } from "./contact.service.js";
import { getOrOpenConversation, touchConversation } from "./conversation.service.js";
import { applyStatusUpdate, previewOf } from "./message.service.js";
import { handleInbound } from "./automation.service.js";
import { normalizeWaPhone } from "../whatsapp.phone.js";
import { cleanString, notifyAdmin } from "../whatsapp.utils.js";

const AUTOMATION_TYPES = new Set(["text", "button", "interactive"]);
const MAX_EVENT_ATTEMPTS = 5;

/** Splits a Meta webhook body into individual idempotent events. */
export function extractEvents(body) {
  const events = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      if (change?.field !== "messages") continue;
      const value = change.value || {};
      // Ignore events for a different number on the same Meta app
      const forNumber = value.metadata?.phone_number_id;
      if (env.whatsappPhoneNumberId && forNumber && String(forNumber) !== String(env.whatsappPhoneNumberId)) continue;

      const profiles = new Map((value.contacts || []).map((c) => [String(c.wa_id), c.profile?.name || ""]));
      for (const m of value.messages || []) {
        if (!m?.id) continue;
        events.push({
          eventId: `msg:${m.id}`,
          eventType: "message",
          providerMessageId: m.id,
          phone: String(m.from || ""),
          payload: { message: m, profileName: profiles.get(String(m.from)) || "" },
        });
      }
      for (const s of value.statuses || []) {
        if (!s?.id || !s?.status) continue;
        events.push({
          eventId: `status:${s.id}:${s.status}`,
          eventType: "status",
          providerMessageId: s.id,
          phone: String(s.recipient_id || ""),
          payload: { status: s },
        });
      }
    }
  }
  return events;
}

/** Meta inbound message → fields we store. */
export function parseInbound(m) {
  const type = String(m.type || "unknown");
  const out = { messageType: type, text: "", interactive: null, media: null };
  switch (type) {
    case "text":
      out.text = m.text?.body || "";
      break;
    case "button":
      out.text = m.button?.text || m.button?.payload || "";
      out.interactive = { replyId: m.button?.payload || "", title: m.button?.text || "" };
      break;
    case "interactive": {
      const r = m.interactive?.button_reply || m.interactive?.list_reply || {};
      out.text = r.title || "";
      out.interactive = { replyId: r.id || "", title: r.title || "" };
      break;
    }
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const media = m[type] || {};
      out.media = { id: media.id || "", mimeType: media.mime_type || "", caption: media.caption || "", filename: media.filename || "" };
      out.text = media.caption || "";
      break;
    }
    case "location":
      out.text = `📍 ${m.location?.name || ""} ${m.location?.latitude ?? ""},${m.location?.longitude ?? ""}`.trim();
      break;
    case "reaction":
      out.text = m.reaction?.emoji || "";
      break;
    case "contacts":
      out.text = "[contact card]";
      break;
    default:
      out.text = "";
  }
  out.text = cleanString(out.text, 4096);
  return out;
}

async function processMessageEvent(event) {
  const m = event.payload?.message || {};
  const phone = normalizeWaPhone(m.from);
  if (!phone) return { status: "ignored", note: "invalid sender" };
  const at = m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date();
  const parsed = parseInbound(m);

  const contact = await findOrCreateContact({ phone, profileName: event.payload?.profileName, seenAt: at, inbound: true });
  const { conversation, isNew } = await getOrOpenConversation(contact);

  let message;
  try {
    message = await WhatsAppMessage.create({
      conversationId: conversation._id,
      contactId: contact._id,
      phone,
      providerMessageId: m.id,
      direction: "inbound",
      origin: "customer",
      status: "received",
      timestamp: at,
      ...parsed,
    });
  } catch (err) {
    // Same provider message already stored → never process it twice
    if (err?.code === 11000) return { status: "ignored", note: "duplicate message" };
    throw err;
  }

  await touchConversation(conversation._id, { preview: previewOf(message), at, direction: "inbound", inbound: true });
  conversation.lastInboundAt = at;
  notifyAdmin("inbound", { conversationId: String(conversation._id) });

  if (parsed.messageType === "reaction" || !AUTOMATION_TYPES.has(parsed.messageType)) {
    return { status: "processed", note: "stored (no automation for this type)" };
  }
  const outcome = await handleInbound({ conversation, contact, message, isNew });
  return { status: "processed", note: outcome?.action || outcome?.skipped || "" };
}

async function processEvent(eventDoc) {
  try {
    const result =
      eventDoc.eventType === "message"
        ? await processMessageEvent(eventDoc)
        : eventDoc.eventType === "status"
          ? { status: await applyStatusUpdate(eventDoc.payload?.status) }
          : { status: "ignored" };
    await WhatsAppWebhookEvent.updateOne(
      { _id: eventDoc._id },
      { $set: { status: result.status, processedAt: new Date(), error: result.note && result.status === "ignored" ? result.note : "" }, $inc: { attempts: 1 } }
    );
    return result.status;
  } catch (err) {
    console.error(`[whatsapp] webhook event ${eventDoc.eventType} failed:`, err?.message || err);
    await WhatsAppWebhookEvent.updateOne(
      { _id: eventDoc._id },
      { $set: { status: "failed", error: cleanString(err?.message || "Processing failed", 500) }, $inc: { attempts: 1 } }
    );
    return "failed";
  }
}

/**
 * Persist-then-process. Duplicate deliveries hit the unique eventId and are
 * skipped before any side effect happens.
 */
export async function ingestWebhook(body, { simulated = false } = {}) {
  const events = extractEvents(body);
  const summary = { received: events.length, duplicates: 0, processed: 0, ignored: 0, failed: 0 };
  for (const ev of events) {
    let doc;
    try {
      doc = await WhatsAppWebhookEvent.create({ ...ev, simulated });
    } catch (err) {
      if (err?.code === 11000) {
        summary.duplicates += 1;
        continue;
      }
      throw err;
    }
    const status = await processEvent(doc.toObject());
    summary[status] = (summary[status] || 0) + 1;
  }
  return summary;
}

/** Worker: retry events that failed or were left unprocessed (e.g. crash mid-request). */
export async function reprocessStuckEvents({ limit = 20 } = {}) {
  const stale = new Date(Date.now() - 2 * 60 * 1000);
  const rows = await WhatsAppWebhookEvent.find({
    attempts: { $lt: MAX_EVENT_ATTEMPTS },
    $or: [{ status: "failed" }, { status: "received", receivedAt: { $lt: stale } }],
  })
    .sort({ receivedAt: 1 })
    .limit(limit)
    .lean();
  let n = 0;
  for (const doc of rows) {
    // Claim by bumping attempts (compare-and-set) so parallel workers don't double-process
    const claimed = await WhatsAppWebhookEvent.findOneAndUpdate(
      { _id: doc._id, attempts: doc.attempts },
      { $set: { status: "received" }, $inc: { attempts: 1 } },
      { returnDocument: "after" }
    ).lean();
    if (!claimed) continue;
    await processEvent(claimed);
    n += 1;
  }
  return n;
}

export async function listWebhookEvents(query = {}) {
  const filter = {};
  if (query.status) filter.status = cleanString(query.status, 20);
  if (query.eventType) filter.eventType = cleanString(query.eventType, 20);
  const rows = await WhatsAppWebhookEvent.find(filter).select("-payload").sort({ receivedAt: -1 }).limit(100).lean();
  return rows;
}
