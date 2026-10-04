import mongoose from "mongoose";
import { Lead } from "../../leads/leads.model.js";
import { Staff } from "../../staff/staff.model.js";
import { WhatsAppConversation, WA_CONVERSATION_STATUSES } from "../models/whatsappConversation.model.js";
import { WhatsAppContact } from "../models/whatsappContact.model.js";
import { WhatsAppMessage } from "../models/whatsappMessage.model.js";
import { WA_CONFIG } from "../whatsapp.config.js";
import {
  assertObjectId,
  badRequest,
  cleanString,
  cleanTags,
  escapeRegex,
  notFound,
  notifyAdmin,
  pageResult,
  parsePaging,
} from "../whatsapp.utils.js";

const FLOW_RESET = { currentAutomation: null, currentStep: "", flowData: {}, flowRetries: 0, flowStartedAt: null };

/**
 * Returns the contact's conversation, creating it on first contact and
 * reopening it when it was Closed. `isNew` lets automation fire
 * new-conversation triggers.
 */
export async function getOrOpenConversation(contact) {
  let isNew = false;
  let conversation = await WhatsAppConversation.findOne({ contactId: contact._id });
  if (!conversation) {
    try {
      conversation = await WhatsAppConversation.create({ contactId: contact._id, phone: contact.normalizedPhone, tags: contact.tags || [] });
      isNew = true;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      conversation = await WhatsAppConversation.findOne({ contactId: contact._id });
    }
  } else if (conversation.status === "Closed") {
    Object.assign(conversation, { status: "Open", closedAt: null, humanHandover: false, ...FLOW_RESET });
    conversation.reopenedCount += 1;
    await conversation.save();
    isNew = true;
  }
  return { conversation, isNew };
}

/** Updates list-preview fields after a message is stored. */
export async function touchConversation(conversationId, { preview, at = new Date(), direction, inbound = false }) {
  const $set = { lastMessage: cleanString(preview, 200), lastMessageAt: at, lastMessageDirection: direction };
  const update = { $set };
  if (inbound) {
    $set.lastInboundAt = at;
    update.$inc = { unreadCount: 1 };
  }
  await WhatsAppConversation.updateOne({ _id: conversationId }, update);
}

export function isWithinServiceWindow(conversation, now = Date.now()) {
  const last = conversation?.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0;
  return Boolean(last) && now - last < WA_CONFIG.customerServiceWindowMs;
}

async function decorate(rows) {
  const contactIds = rows.map((r) => r.contactId);
  const leadIds = rows.map((r) => r.leadId).filter(Boolean);
  const [contacts, leads] = await Promise.all([
    WhatsAppContact.find({ _id: { $in: contactIds } }).select("displayName profileName normalizedPhone tags optOut sourceReferences").lean(),
    leadIds.length ? Lead.find({ _id: { $in: leadIds } }).select("status name").lean() : [],
  ]);
  const contactMap = new Map(contacts.map((c) => [String(c._id), c]));
  const leadMap = new Map(leads.map((l) => [String(l._id), l]));
  return rows.map((r) => {
    const c = contactMap.get(String(r.contactId)) || {};
    const lead = r.leadId ? leadMap.get(String(r.leadId)) : null;
    return {
      ...r,
      contactName: c.displayName || c.profileName || "",
      optOut: Boolean(c.optOut),
      contactTags: c.tags || [],
      sourceTypes: [...new Set((c.sourceReferences || []).map((s) => s.type))],
      leadStatus: lead?.status || "",
      windowOpen: isWithinServiceWindow(r),
    };
  });
}

export async function listConversations(query = {}) {
  const paging = parsePaging(query, { defaultLimit: 30 });
  const filter = {};
  if (query.status && WA_CONVERSATION_STATUSES.includes(query.status)) filter.status = query.status;
  if (query.assignedTo === "unassigned") filter.assignedTo = null;
  else if (query.assignedTo && mongoose.isValidObjectId(query.assignedTo)) filter.assignedTo = query.assignedTo;
  if (query.handover === "true") filter.humanHandover = true;
  if (query.unread === "true") filter.unreadCount = { $gt: 0 };
  if (query.tag) filter.tags = cleanString(query.tag, 40).toLowerCase();
  const search = cleanString(query.search, 80);
  if (search) {
    const digits = search.replace(/\D/g, "");
    const rx = new RegExp(escapeRegex(search), "i");
    const contactIds = await WhatsAppContact.find({ $or: [{ displayName: rx }, { profileName: rx }] }).select("_id").limit(200).lean();
    filter.$or = [{ contactId: { $in: contactIds.map((c) => c._id) } }, ...(digits.length >= 3 ? [{ phone: new RegExp(escapeRegex(digits)) }] : [])];
  }

  const [rows, total, counts] = await Promise.all([
    WhatsAppConversation.find(filter)
      .select("-flowData")
      .sort({ lastMessageAt: -1, _id: -1 })
      .skip(paging.skip)
      .limit(paging.limit)
      .lean(),
    WhatsAppConversation.countDocuments(filter),
    WhatsAppConversation.aggregate([{ $group: { _id: "$status", n: { $sum: 1 }, unread: { $sum: { $cond: [{ $gt: ["$unreadCount", 0] }, 1, 0] } } } }]),
  ]);
  const byStatus = Object.fromEntries(WA_CONVERSATION_STATUSES.map((s) => [s, 0]));
  let unread = 0;
  for (const c of counts) {
    byStatus[c._id] = c.n;
    unread += c.unread;
  }
  return { ...pageResult(await decorate(rows), total, paging), counts: { byStatus, unread } };
}

export async function getConversation(id) {
  const row = await WhatsAppConversation.findById(assertObjectId(id, "conversation id")).lean();
  if (!row) throw notFound("Conversation not found");
  const [decorated] = await decorate([row]);
  const contact = await WhatsAppContact.findById(row.contactId).lean();
  const lead = row.leadId ? await Lead.findById(row.leadId).select("name status interest source counsellor followUp").lean() : null;
  return { ...decorated, contact, lead };
}

/** Newest-first page of messages, returned oldest-first for rendering. */
export async function getConversationMessages(id, query = {}) {
  const conversationId = assertObjectId(id, "conversation id");
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 40));
  const filter = { conversationId };
  if (query.before) {
    const before = new Date(query.before);
    if (!Number.isNaN(before.getTime())) filter.timestamp = { $lt: before };
  }
  const rows = await WhatsAppMessage.find(filter)
    .select("-lockedUntil -interactive")
    .sort({ timestamp: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit).reverse(), hasMore };
}

export async function markRead(id) {
  await WhatsAppConversation.updateOne({ _id: assertObjectId(id, "conversation id") }, { $set: { unreadCount: 0 } });
  return { ok: true };
}

export async function updateConversation(id, body = {}) {
  const conversation = await WhatsAppConversation.findById(assertObjectId(id, "conversation id"));
  if (!conversation) throw notFound("Conversation not found");

  if (body.status !== undefined) {
    if (!WA_CONVERSATION_STATUSES.includes(body.status)) throw badRequest("Invalid conversation status");
    conversation.status = body.status;
    conversation.closedAt = body.status === "Closed" ? new Date() : null;
    if (body.status === "Closed") Object.assign(conversation, FLOW_RESET);
  }
  if (body.assignedTo !== undefined) {
    if (!body.assignedTo) {
      conversation.assignedTo = null;
      conversation.assignedToName = "";
    } else {
      const staff = await Staff.findById(assertObjectId(body.assignedTo, "staff id")).select("personalDetails.fullName").lean();
      if (!staff) throw notFound("Staff not found");
      conversation.assignedTo = staff._id;
      conversation.assignedToName = staff.personalDetails?.fullName || "Staff";
    }
  }
  if (body.tags !== undefined) {
    conversation.tags = cleanTags(body.tags);
    await WhatsAppContact.updateOne({ _id: conversation.contactId }, { $set: { tags: conversation.tags } });
  }
  await conversation.save();
  notifyAdmin("conversation", { conversationId: String(conversation._id) });
  return getConversation(conversation._id);
}

export async function setHandover(id, on, reason = "") {
  const $set = on
    ? { humanHandover: true, handoverAt: new Date(), handoverReason: cleanString(reason, 200) || "Manual", ...FLOW_RESET }
    : { humanHandover: false, handoverReason: "" };
  if (on) $set.status = "Pending";
  const conversation = await WhatsAppConversation.findByIdAndUpdate(assertObjectId(id, "conversation id"), { $set }, { returnDocument: "after" }).lean();
  if (!conversation) throw notFound("Conversation not found");
  notifyAdmin("handover", { conversationId: String(conversation._id), on });
  return getConversation(conversation._id);
}

export { FLOW_RESET };
