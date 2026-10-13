import crypto from "node:crypto";
import { transactionalEvent } from "./execution.service.js";
import { ensureDefaultAutomations } from "./automation.service.js";
import { WhatsAppContact } from "../models/whatsappContact.model.js";
import { WA_CONFIG } from "../whatsapp.config.js";
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
  if (body?.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) return events;
  for (const entry of body.entry) {
    if (env.whatsappBusinessAccountId && String(entry?.id) !== env.whatsappBusinessAccountId) continue;
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== "messages" || change.value?.messaging_product !== "whatsapp") continue;
      const value = change.value || {};
      // Ignore events for a different number on the same Meta app
      const forNumber = value.metadata?.phone_number_id;
      if (env.whatsappPhoneNumberId && String(forNumber || "") !== env.whatsappPhoneNumberId) continue;

      const profiles = new Map((Array.isArray(value.contacts) ? value.contacts : []).filter(Boolean).map((c) => [String(c.wa_id), c.profile?.name || ""]));
      for (const m of Array.isArray(value.messages) ? value.messages : []) {
        if (!m?.id) continue;
        events.push({
          eventId: `msg:${m.id}`,
          eventType: "message",
          providerMessageId: m.id,
          phone: normalizeWaPhone(m.from) || "",
          payload: { message: m, profileName: profiles.get(String(m.from)) || "" },
        });
      }
      for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
        if (!s?.id || !s?.status) continue;
        events.push({
          eventId: `status:${s.id}:${s.status}`,
          eventType: "status",
          providerMessageId: s.id,
          phone: normalizeWaPhone(s.recipient_id) || "",
          payload: { status: s },
        });
      }
      for (const error of Array.isArray(value.errors) ? value.errors : []) {
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify(error)).digest("hex");
        events.push({ eventId: `error:${entry.id}:${fingerprint}`, eventType: "error", payload: { code: String(error.code || "PROVIDER_ERROR") } });
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
  const at = m.timestamp && Number.isFinite(Number(m.timestamp)) ? new Date(Math.min(Date.now(), Number(m.timestamp) * 1000)) : new Date();
  const parsed = parseInbound(m);
  // Event history may expire while messages are retained. Read before insertion:
  // catching a duplicate-key write inside MongoDB would abort the transaction.
  if (await WhatsAppMessage.exists({ providerMessageId: m.id, direction: 'inbound' })) {
    return { status: 'ignored', note: 'duplicate message already committed' };
  }

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
      simulatedInbound: Boolean(event.simulated),
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

/** Persist only. HTTP acknowledgement never waits for automation or Meta. */
export async function ingestWebhook(body, { simulated = false } = {}) {
  const events = extractEvents(body);
  const summary = { received: events.length, duplicates: 0, queued: 0 };
  for (const event of events) {
    try {
      await WhatsAppWebhookEvent.create({ ...event, simulated });
      summary.queued += 1;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      summary.duplicates += 1;
    }
  }
  return summary;
}

/** Ordered per sender, leased across processes; all chatbot writes commit atomically. */
export async function reprocessStuckEvents({ limit = 20, deadline = Date.now() + 20000 } = {}) {
  await ensureDefaultAutomations();
  const now = new Date();
  const rows = await WhatsAppWebhookEvent.find({
    attempts: { $lt: MAX_EVENT_ATTEMPTS },
    $or: [
      { status: 'received' },
      { status: 'failed', nextAttemptAt: { $lte: now } },
      { status: 'processing', lockedUntil: { $lt: now } },
    ],
  }).sort({ receivedAt: 1, _id: 1 }).limit(limit).lean();
  let processed = 0;
  for (const doc of rows) {
    if (Date.now() >= deadline) break;
    const token = crypto.randomUUID();
    const until = new Date(Date.now() + WA_CONFIG.workerLeaseMs);
    let contact = null;
    if (doc.eventType === 'message' && doc.phone) {
      contact = await findOrCreateContact({ phone: doc.phone });
      contact = await WhatsAppContact.findOneAndUpdate({
        _id: contact._id, $or: [{ processingUntil: null }, { processingUntil: { $lt: new Date() } }],
      }, { $set: { processingToken: token, processingUntil: until } }, { returnDocument: 'after' });
      if (!contact) continue;
      // Receive order is deterministic even when separate cron instances overlap.
      const earlier = await WhatsAppWebhookEvent.exists({ phone: doc.phone, eventType: 'message', status: { $in: ['received', 'processing', 'failed'] },
        $or: [{ receivedAt: { $lt: doc.receivedAt } }, { receivedAt: doc.receivedAt, _id: { $lt: doc._id } }],
      });
      if (earlier) {
        await WhatsAppContact.updateOne({ _id: contact._id, processingToken: token }, { $set: { processingToken: '', processingUntil: null } });
        continue;
      }
    }
    try {
      const claimed = await WhatsAppWebhookEvent.findOneAndUpdate({ _id: doc._id, status: doc.status, attempts: doc.attempts,
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: new Date() } }],
      }, { $set: { status: 'processing', processingToken: token, lockedUntil: until }, $inc: { attempts: 1 } }, { returnDocument: 'after' }).lean();
      if (!claimed) continue;
      await transactionalEvent(doc.eventId, async () => {
        // Fencing write: an expired worker cannot commit over a new owner.
        if (contact) {
          const fence = await WhatsAppContact.updateOne({ _id: contact._id, processingToken: token }, { $set: { processingUntil: until } });
          if (!fence.matchedCount) throw new Error('Worker lease lost');
        }
        const result = doc.eventType === 'message' ? await processMessageEvent(claimed)
          : doc.eventType === 'status' ? { status: await applyStatusUpdate(doc.payload?.status, { simulated: doc.simulated }) }
          : { status: 'ignored', note: doc.eventType === 'error' ? `Provider error ${doc.payload?.code || ''}` : 'unsupported event' };
        const done = await WhatsAppWebhookEvent.updateOne({ _id: doc._id, processingToken: token }, {
          $set: { status: result.status, processedAt: new Date(), lockedUntil: null, nextAttemptAt: null, error: result.status === 'ignored' ? result.note || '' : '' },
        });
        if (!done.matchedCount) throw new Error('Event lease lost');
      });
      notifyAdmin('inbound_processed');
      processed += 1;
    } catch (error) {
      // Do not log customer input or Mongo connection strings.
      const message = error?.code === 20 ? 'MongoDB replica set is required for transactional chatbot processing' : `Event processing failed (${error?.code || error?.name || 'error'})`;
      console.error('[whatsapp]', message);
      await WhatsAppWebhookEvent.updateOne({ _id: doc._id, processingToken: token }, { $set: {
        status: 'failed', lockedUntil: null, nextAttemptAt: new Date(Date.now() + 30000), error: message,
      } });
    } finally {
      if (contact) await WhatsAppContact.updateOne({ _id: contact._id, processingToken: token }, { $set: { processingToken: '', processingUntil: null } });
    }
  }
  return processed;
}

export async function listWebhookEvents(query = {}) {
  const filter = {};
  if (query.status) filter.status = cleanString(query.status, 20);
  if (query.eventType) filter.eventType = cleanString(query.eventType, 20);
  const rows = await WhatsAppWebhookEvent.find(filter).select("-payload -phone -processingToken").sort({ receivedAt: -1 }).limit(100).lean();
  return rows;
}

export async function retryWebhookEvent(id) {
  const event = await WhatsAppWebhookEvent.findOneAndUpdate({ _id: id, status: 'failed' }, {
    $set: { status: 'received', attempts: 0, nextAttemptAt: null, lockedUntil: null, error: '' },
  }, { returnDocument: 'after' }).select('-payload -phone -processingToken').lean();
  if (!event) throw Object.assign(new Error('Only failed webhook events can be requeued'), { name: 'ValidationError' });
  return event;
}
