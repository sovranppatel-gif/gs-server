import { Lead, LEAD_STATUSES } from "../../leads/leads.model.js";
import { emitSectionUpdate } from "../../../lib/socket.js";
import { WhatsAppConversation } from "../models/whatsappConversation.model.js";
import { localPart, phoneVariants } from "../whatsapp.phone.js";
import { cleanString } from "../whatsapp.utils.js";

/**
 * Create-or-update a Lead from WhatsApp using the existing Lead model.
 * Matching is by phone (all stored spellings), so repeated messages and
 * repeated flows update one lead instead of creating duplicates.
 */
export async function upsertLeadFromWhatsapp({ phone, name, interest = "", notes = "", status = "", conversationId = null }) {
  const variants = phoneVariants(phone);
  if (!variants.length) return { lead: null, created: false };

  const stamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  const noteLine = notes ? `[WhatsApp ${stamp}] ${cleanString(notes, 1500)}` : "";
  const existing = await Lead.findOne({ phone: { $in: variants } }).sort({ updatedAt: -1 });

  let lead;
  let created = false;
  if (existing) {
    if (interest) existing.interest = cleanString(interest, 150);
    if (noteLine) existing.notes = cleanString(existing.notes ? `${existing.notes}\n${noteLine}` : noteLine, 2000);
    if (status && LEAD_STATUSES.includes(status)) existing.status = status;
    if ((!existing.name || existing.name === "WhatsApp Lead") && name) existing.name = cleanString(name, 120);
    existing.updatedBy = "whatsapp";
    lead = await existing.save();
  } else {
    lead = await Lead.create({
      name: cleanString(name, 120) || "WhatsApp Lead",
      phone: localPart(phone),
      source: "WhatsApp",
      interest: cleanString(interest, 150),
      status: status && LEAD_STATUSES.includes(status) ? status : "New",
      notes: noteLine,
      createdBy: "whatsapp",
      updatedBy: "whatsapp",
    });
    created = true;
  }

  if (conversationId) await WhatsAppConversation.updateOne({ _id: conversationId }, { $set: { leadId: lead._id } });
  try {
    emitSectionUpdate({ section: "leads", action: created ? "create" : "update", resourceId: String(lead._id), at: new Date().toISOString() });
  } catch {
    /* socket optional */
  }
  return { lead: lead.toObject(), created };
}

export async function findLeadForPhone(phone) {
  const variants = phoneVariants(phone);
  if (!variants.length) return null;
  return Lead.findOne({ phone: { $in: variants } }).select("name status interest source").sort({ updatedAt: -1 }).lean();
}
