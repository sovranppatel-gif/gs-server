import mongoose from "mongoose";
import { WhatsAppMessage, WA_MESSAGE_STATUSES, WA_STATUS_RANK } from "../models/whatsappMessage.model.js";
import { WhatsAppCampaignRecipient, WA_RECIPIENT_RANK } from "../models/whatsappCampaignRecipient.model.js";
import { WhatsAppContact } from "../models/whatsappContact.model.js";
import { WhatsAppConversation } from "../models/whatsappConversation.model.js";
import { WhatsAppTemplate } from "../models/whatsappTemplate.model.js";
import { sendInteractive, sendMedia, sendTemplate, sendText } from "../whatsapp.client.js";
import { env } from "../../../config/env.js";
import { isDryRun } from "../whatsapp.config.js";
import { getSettings } from "./settings.service.js";
import { WorkshopWhatsappMessage } from '../../workshopManagement/workshopManagement.model.js';
import { applyStatusUpdates as applyWorkshopStatusUpdates } from '../../workshopManagement/whatsapp.service.js';
import { safeError } from "../whatsapp.security.js";
import { WA_CONFIG } from "../whatsapp.config.js";
import { isWithinServiceWindow, touchConversation } from "./conversation.service.js";
import { renderTemplateBody, templateSendability } from "./template.service.js";
import {
  assertObjectId,
  badRequest,
  cleanString,
  escapeRegex,
  notFound,
  notifyAdmin,
  pageResult,
  parsePaging,
} from "../whatsapp.utils.js";

export function previewOf(message) {
  if (message.text) return message.text;
  if (message.templateName) return `📄 Template: ${message.templateName}`;
  if (message.messageType && message.messageType !== "text") return `[${message.messageType}]`;
  return "";
}

/**
 * Stores an outbound message in the durable outbox (status "queued").
 * Nothing is sent here — call dispatchMessage() or let the worker pick it up.
 */
export async function createOutbound({
  conversationId = null,
  contactId = null,
  phone,
  text = "",
  template = null, // { name, language, params, bodyText }
  interactive = null,
  media = null, // { type, link|id, caption }
  origin,
  automationId = null,
  campaignId = null,
  campaignRecipientId = null,
  sentBy = "",
  touch = true,
  idempotencyKey = "",
  dryRun = isDryRun(),
}) {
  let messageType = "text";
  if (template) messageType = "template";
  else if (interactive) messageType = "interactive";
  else if (media) messageType = media.type;

  const renderedText = template ? renderTemplateBody(template.bodyText, template.params) : text;
  const message = await WhatsAppMessage.create({
    conversationId,
    contactId,
    phone,
    direction: "outbound",
    idempotencyKey,
    dryRun,
    queuedMode: dryRun ? 'dry_run' : 'live',
    messageType,
    text: cleanString(renderedText, 4096),
    templateName: template?.name || "",
    templateLanguage: template?.language || "",
    templateParams: template?.params || [],
    interactive,
    media,
    origin,
    automationId,
    campaignId,
    campaignRecipientId,
    sentBy,
    status: "queued",
    nextAttemptAt: new Date(),
    timestamp: new Date(),
  });
  if (touch && conversationId) {
    await touchConversation(conversationId, { preview: previewOf(message), at: message.timestamp, direction: "outbound" });
  }
  return message;
}

function sendFor(message) {
  switch (message.messageType) {
    case "template":
      return sendTemplate(message.phone, { name: message.templateName, language: message.templateLanguage || "en", bodyParams: message.templateParams });
    case "interactive":
      return sendInteractive(message.phone, message.interactive);
    case "image":
    case "document":
    case "video":
    case "audio": {
      const { type, ...rest } = message.media || {};
      return sendMedia(message.phone, message.messageType, rest);
    }
    default:
      return sendText(message.phone, message.text);
  }
}

/** Keeps the campaign recipient row in step with its message. */
export async function syncRecipient(message) {
  if (!message.campaignRecipientId) return;
  const map = { accepted: "Sent", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed" };
  const next = map[message.status];
  const recipient = await WhatsAppCampaignRecipient.findById(message.campaignRecipientId);
  if (!recipient) return;
  if (!next) {
    if (message.error?.message) {
      recipient.error = message.error.message;
      await recipient.save();
    }
    return;
  }
  if (next === "Failed") {
    if ((WA_RECIPIENT_RANK[recipient.status] ?? 0) >= WA_RECIPIENT_RANK.Delivered) return;
    Object.assign(recipient, { status: "Failed", failedAt: message.failedAt || new Date(), error: message.error?.message || "Failed" });
  } else if ((WA_RECIPIENT_RANK[next] ?? 0) > (WA_RECIPIENT_RANK[recipient.status] ?? -1) || recipient.status === "Failed") {
    recipient.status = next;
    recipient.error = "";
    if (next === "Sent" && !recipient.sentAt) recipient.sentAt = message.acceptedAt || new Date();
    if (next === "Delivered") recipient.deliveredAt = message.deliveredAt || new Date();
    if (next === "Read") recipient.readAt = message.readAt || new Date();
  }
  recipient.providerMessageId = message.providerMessageId || recipient.providerMessageId;
  await recipient.save();
}

/**
 * Atomically claims one queued message and sends it. Safe to call from
 * several workers/instances: only the claimant sends.
 */
export async function dispatchMessage(messageId) {
  const now = new Date();
  const message = await WhatsAppMessage.findOneAndUpdate(
    { _id: messageId, status: "queued", nextAttemptAt: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
    { $set: { status: "sending", lockedUntil: new Date(now.getTime() + WA_CONFIG.workerLeaseMs) }, $inc: { attempts: 1 } },
    { returnDocument: "after" }
  );
  if (!message) return null;

  // Consent: never send campaign / automated messages to opted-out contacts.
  if (["campaign", "automation"].includes(message.origin) && message.contactId) {
    const contact = await WhatsAppContact.findById(message.contactId).select("optOut").lean();
    if (contact?.optOut) {
      Object.assign(message, { status: "failed", failedAt: now, lockedUntil: null, error: { code: "OPTED_OUT", message: "Contact opted out", retryable: false } });
      await message.save();
      if (message.campaignRecipientId) {
        await WhatsAppCampaignRecipient.updateOne({ _id: message.campaignRecipientId }, { $set: { status: "Skipped", skipReason: "Opted out" } });
      }
      return message;
    }
  }

  let blocked = null;
  if (!message.queuedMode) blocked = { code: 'LEGACY_MODE_UNKNOWN', message: 'Legacy queued message has no reliable operating mode. Review before an intentional retry.', retryable: false };
  if (Boolean(message.dryRun) !== isDryRun()) blocked = { code: 'MODE_CHANGED', message: 'Message was queued in a different operating mode; recreate intentionally', retryable: false };
  if (message.origin === 'automation') {
    const [conversation, settings] = await Promise.all([
      WhatsAppConversation.findById(message.conversationId).lean(), getSettings(),
    ]);
    if (conversation?.humanHandover || !settings.autoReplyEnabled || !env.whatsappAutoReplyEnabled) blocked = { code: 'BOT_PAUSED', message: 'Bot paused or disabled before dispatch', retryable: false };
  }
  if (message.messageType !== 'template') {
    const conversation = message.conversationId ? await WhatsAppConversation.findById(message.conversationId).lean() : null;
    if (!isWithinServiceWindow(conversation)) blocked = { code: 'WINDOW_CLOSED', message: '24-hour customer service window closed; approved template required', retryable: false };
  } else {
    const template = await WhatsAppTemplate.findOne({ name: message.templateName, language: message.templateLanguage }).lean();
    if (!template || !templateSendability(template).allowed) blocked = { code: 'TEMPLATE_NOT_APPROVED', message: 'Template is unavailable or not Meta-approved', retryable: false };
    if (!isDryRun() && template?.category === 'MARKETING') {
      const contact = message.contactId ? await WhatsAppContact.findById(message.contactId).select('consentStatus').lean() : null;
      if (contact?.consentStatus !== 'opted_in') blocked = { code: 'CONSENT_REQUIRED', message: 'Marketing template requires explicit opt-in', retryable: false };
    }
  }
  const result = blocked ? { ok: false, error: blocked } : await sendFor(message);
  if (result.ok) {
    Object.assign(message, {
      status: "accepted",
      providerMessageId: result.id || "",
      acceptedAt: new Date(),
      dryRun: Boolean(result.dryRun),
      error: null,
      lockedUntil: null,
      nextAttemptAt: null,
    });
  } else if (result.error.retryable && message.attempts < WA_CONFIG.maxSendAttempts) {
    const delay = WA_CONFIG.retryBackoffMs[Math.min(message.attempts - 1, WA_CONFIG.retryBackoffMs.length - 1)];
    Object.assign(message, { status: "queued", error: result.error, lockedUntil: null, nextAttemptAt: new Date(Date.now() + delay) });
  } else {
    Object.assign(message, { status: "failed", failedAt: new Date(), error: result.error, lockedUntil: null, nextAttemptAt: null });
  }
  await message.save();
  await syncRecipient(message);
  notifyAdmin("message", { conversationId: message.conversationId ? String(message.conversationId) : null, status: message.status });
  return message;
}

/** Claims and dispatches up to `limit` due messages; returns how many were processed. */
export async function dispatchDueMessages({ limit = 20, origins = null, extraFilter = null, deadline = Date.now() + 20000 } = {}) {
  if (limit <= 0) return 0;
  // A process may have died after Meta accepted the request. Never replay that send.
  await WhatsAppMessage.updateMany({ status: 'sending', lockedUntil: { $lt: new Date() } }, { $set: {
    status: 'failed', failedAt: new Date(), lockedUntil: null, nextAttemptAt: null,
    error: { code: 'AMBIGUOUS_CRASH', message: 'Interrupted send; provider acceptance unknown. Do not resend without verification.', retryable: false, ambiguous: true },
  } });
  const now = new Date();
  const filter = { status: "queued", nextAttemptAt: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }], ...(extraFilter || {}) };
  if (origins) filter.origin = { $in: origins };
  const due = await WhatsAppMessage.find(filter).select("_id").sort({ nextAttemptAt: 1 }).limit(limit).lean();
  let processed = 0;
  for (const row of due) {
    if (Date.now() >= deadline) break;
    if (await dispatchMessage(row._id)) processed += 1;
  }
  return processed;
}

/**
 * Webhook / simulated status update. Never downgrades (a late "sent" after
 * "read" is ignored). Returns "processed" or "ignored" (unknown message id —
 * e.g. a message sent by another module).
 */
export async function applyStatusUpdate(status, { simulated = false } = {}) {
  const id = String(status?.id || "");
  const next = String(status?.status || "");
  if (!id || !["sent", "delivered", "read", "failed"].includes(next)) return "ignored";
  const message = await WhatsAppMessage.findOne({ providerMessageId: id });
  if (!message) {
    // Meta supports one configured callback. Preserve workshop delivery tracking too.
    if (!simulated && await WorkshopWhatsappMessage.exists({ 'recipients.waMessageId': id })) {
      await applyWorkshopStatusUpdates({ entry: [{ changes: [{ value: { statuses: [status] } }] }] });
      return 'processed';
    }
    throw new Error('Status arrived before matching outbound record');
  }
  if (message.direction !== 'outbound' || Boolean(message.dryRun) !== Boolean(simulated)) return 'ignored';

  const at = status.timestamp ? new Date(Number(status.timestamp) * 1000) : new Date();
  if (next === "failed") {
    if ((WA_STATUS_RANK[message.status] ?? 0) >= WA_STATUS_RANK.delivered) return "processed";
    const err = status.errors?.[0];
    Object.assign(message, {
      status: "failed",
      failedAt: at,
      error: { code: String(err?.code || "FAILED"), message: safeError(err?.error_data?.details || err?.title || err?.message || "Failed"), retryable: false },
    });
  } else {
    if ((WA_STATUS_RANK[next] ?? 0) <= (WA_STATUS_RANK[message.status] ?? -1)) return "processed";
    message.status = next;
    if (next === "sent") message.sentAt = at;
    if (next === "delivered") {
      message.deliveredAt = at;
      message.sentAt = message.sentAt || at;
    }
    if (next === "read") {
      message.readAt = at;
      message.deliveredAt = message.deliveredAt || at;
    }
  }
  await message.save();
  await syncRecipient(message);
  notifyAdmin("status", { conversationId: message.conversationId ? String(message.conversationId) : null });
  return "processed";
}

/** Manual reply from the inbox. Free text only inside the 24h window. */
export async function sendAgentReply(conversationId, body = {}, by = "master-admin") {
  const conversation = await WhatsAppConversation.findById(assertObjectId(conversationId, "conversation id"));
  if (!conversation) throw notFound("Conversation not found");

  let template = null;
  const text = cleanString(body.text, 4096);
  if (body.templateId) {
    const t = await WhatsAppTemplate.findById(assertObjectId(body.templateId, "template id")).lean();
    if (!t) throw notFound("Template not found");
    const sendability = templateSendability(t);
    if (!sendability.allowed) throw badRequest(sendability.note);
    const params = (Array.isArray(body.params) ? body.params : []).map((p) => cleanString(p, 1000));
    template = { name: t.name, language: t.language, params, bodyText: t.bodyText };
  } else {
    if (!text) throw badRequest("Message text is required");
    if (!isWithinServiceWindow(conversation)) {
      throw badRequest("The 24-hour customer service window is closed. Send an approved template instead.");
    }
  }

  const message = await createOutbound({
    conversationId: conversation._id,
    contactId: conversation.contactId,
    phone: conversation.phone,
    text,
    template,
    origin: "agent",
    sentBy: by,
  });
  const $set = { unreadCount: 0 };
  if (conversation.status === "New") $set.status = "Open";
  await WhatsAppConversation.updateOne({ _id: conversation._id }, { $set });
  const sent = await dispatchMessage(message._id);
  return (sent || message).toObject();
}

/** Re-queues a failed outbound message (manual retry from history/inbox). */
export async function retryMessage(id) {
  const message = await WhatsAppMessage.findById(assertObjectId(id, "message id"));
  if (!message) throw notFound("Message not found");
  if (message.direction !== "outbound" || message.status !== "failed") throw badRequest("Only failed outbound messages can be retried");
  if (message.error?.ambiguous || String(message.error?.code || '').startsWith('AMBIGUOUS_')) throw badRequest('Outcome is unknown. Check Meta delivery and contact before an intentional new send.');
  if (message.error?.code === "OPTED_OUT") throw badRequest("Contact has opted out");
  Object.assign(message, { status: "queued", error: null, failedAt: null, nextAttemptAt: new Date(), attempts: 0, lockedUntil: null });
  if (!message.queuedMode) { message.queuedMode = isDryRun() ? 'dry_run' : 'live'; message.dryRun = isDryRun(); }
  await message.save();
  if (message.campaignRecipientId) {
    await WhatsAppCampaignRecipient.updateOne({ _id: message.campaignRecipientId }, { $set: { status: "Pending", error: "", failedAt: null } });
  }
  return ((await dispatchMessage(message._id)) || message).toObject();
}

export async function listMessages(query = {}) {
  const paging = parsePaging(query, { defaultLimit: 50, maxLimit: 200 });
  const filter = {};
  if (query.direction === "inbound" || query.direction === "outbound") filter.direction = query.direction;
  if (query.status && WA_MESSAGE_STATUSES.includes(query.status)) filter.status = query.status;
  if (query.origin) filter.origin = cleanString(query.origin, 20);
  if (query.campaignId && mongoose.isValidObjectId(query.campaignId)) filter.campaignId = query.campaignId;
  if (query.dryRun === "true") filter.dryRun = true;
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(/^\d{4}-\d{2}-\d{2}$/.test(query.to) ? `${query.to}T23:59:59.999` : query.to);
  }
  const search = cleanString(query.search, 80);
  if (search) {
    const digits = search.replace(/\D/g, "");
    filter.$or = digits.length >= 4 && digits.length === search.replace(/[\s+-]/g, "").length
      ? [{ phone: new RegExp(escapeRegex(digits)) }]
      : [{ text: new RegExp(escapeRegex(search), "i") }, { templateName: new RegExp(escapeRegex(search), "i") }];
  }
  const [rows, total] = await Promise.all([
    WhatsAppMessage.find(filter).select("-interactive -lockedUntil").sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit).lean(),
    WhatsAppMessage.countDocuments(filter),
  ]);
  const contacts = await WhatsAppContact.find({ _id: { $in: rows.map((r) => r.contactId).filter(Boolean) } })
    .select("displayName profileName")
    .lean();
  const names = new Map(contacts.map((c) => [String(c._id), c.displayName || c.profileName || ""]));
  return pageResult(rows.map((r) => ({ ...r, contactName: names.get(String(r.contactId)) || "" })), total, paging);
}
