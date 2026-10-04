import { Lead } from "../../leads/leads.model.js";
import { Admission } from "../../../models/Admission.js";
import { User, USER_TYPES } from "../../../models/User.js";
import { Staff } from "../../staff/staff.model.js";
import { Faculty } from "../../faculties/faculty.model.js";
import { Enquiry } from "../../enquiries/enquiries.model.js";
import { WhatsAppContact, WA_CONSENT_STATUSES } from "../models/whatsappContact.model.js";
import { WhatsAppConversation } from "../models/whatsappConversation.model.js";
import { normalizeWaPhone, phoneVariants, localPart } from "../whatsapp.phone.js";
import {
  CURRENT_STAFF_STATUSES,
  assertObjectId,
  badRequest,
  cleanString,
  cleanTags,
  escapeRegex,
  notFound,
  pageResult,
  parsePaging,
} from "../whatsapp.utils.js";

const Q_TIMEOUT = 5000;

/**
 * Looks the number up in existing business records (read-only) and returns
 * pointers. Order = display-name priority. Workshop data is never consulted.
 */
export async function resolveSources(waPhone) {
  const variants = phoneVariants(waPhone);
  if (!variants.length) return [];
  const local = localPart(waPhone);

  const [admissions, students, staff, faculty, leads, enquiries] = await Promise.all([
    Admission.find({ softDelete: { $ne: true }, $or: [{ normalizedPhone: local }, { phone: { $in: variants } }] })
      .select("applicant course status admissionId")
      .sort({ admissionDate: -1 })
      .limit(3)
      .maxTimeMS(Q_TIMEOUT)
      .lean(),
    User.find({ type: USER_TYPES.STUDENT, phone: { $in: variants } }).select("name email").limit(2).maxTimeMS(Q_TIMEOUT).lean(),
    Staff.find({
      softDelete: { $ne: true },
      $or: [{ "personalDetails.personalMobile": { $in: variants } }, { "personalDetails.whatsapp": { $in: variants } }],
    })
      .select("personalDetails.fullName employmentDetails.designationName status")
      .limit(2)
      .maxTimeMS(Q_TIMEOUT)
      .lean(),
    Faculty.find({ softDelete: { $ne: true }, "personalDetails.mobile": { $in: variants } })
      .select("personalDetails.fullName employmentDetails.designation status")
      .limit(2)
      .maxTimeMS(Q_TIMEOUT)
      .lean(),
    Lead.find({ phone: { $in: variants } }).select("name status interest").sort({ updatedAt: -1 }).limit(3).maxTimeMS(Q_TIMEOUT).lean(),
    Enquiry.find({ mobile: { $in: variants } })
      .select("fullName enquiryType serviceRequested courseRequested")
      .sort({ submittedAt: -1 })
      .limit(2)
      .maxTimeMS(Q_TIMEOUT)
      .lean(),
  ]);

  const refs = [];
  for (const a of admissions) refs.push({ type: "admission", refId: String(a._id), label: a.applicant, detail: `${a.course} · ${a.status} · ${a.admissionId}` });
  for (const u of students) refs.push({ type: "student", refId: String(u._id), label: u.name || u.email, detail: "Student portal account" });
  for (const s of staff) {
    refs.push({ type: "staff", refId: String(s._id), label: s.personalDetails?.fullName || "Staff", detail: `${s.employmentDetails?.designationName || "Staff"} · ${s.status}` });
  }
  for (const f of faculty) {
    refs.push({ type: "faculty", refId: String(f._id), label: f.personalDetails?.fullName || "Faculty", detail: `${f.employmentDetails?.designation || "Faculty"} · ${f.status}` });
  }
  for (const l of leads) refs.push({ type: "lead", refId: String(l._id), label: l.name, detail: `${l.status}${l.interest ? ` · ${l.interest}` : ""}` });
  for (const e of enquiries) {
    refs.push({ type: "enquiry", refId: String(e._id), label: e.fullName, detail: `${e.enquiryType} · ${e.serviceRequested || e.courseRequested || "Enquiry"}` });
  }
  return refs;
}

function displayNameFrom(refs, fallback) {
  return refs.find((r) => r.label)?.label || fallback || "";
}

/**
 * Idempotent: concurrent webhooks for the same number converge on one row
 * thanks to the unique normalizedPhone index + upsert.
 */
export async function findOrCreateContact({ phone, profileName = "", seenAt = new Date(), inbound = false }) {
  const normalizedPhone = normalizeWaPhone(phone);
  if (!normalizedPhone) throw badRequest("Invalid WhatsApp number");

  const $set = { lastSeenAt: seenAt };
  if (profileName) $set.profileName = cleanString(profileName, 120);
  if (inbound) $set.lastInboundAt = seenAt;

  let contact;
  try {
    contact = await WhatsAppContact.findOneAndUpdate(
      { normalizedPhone },
      { $set, $setOnInsert: { normalizedPhone } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err?.code !== 11000) throw err;
    contact = await WhatsAppContact.findOneAndUpdate({ normalizedPhone }, { $set }, { returnDocument: "after" });
  }

  if (!contact.resolvedAt) {
    const refs = await resolveSources(normalizedPhone).catch(() => []);
    contact.sourceReferences = refs;
    contact.resolvedAt = new Date();
    if (!contact.displayName) contact.displayName = displayNameFrom(refs, contact.profileName);
    await contact.save();
  } else if (!contact.displayName && contact.profileName) {
    contact.displayName = contact.profileName;
    await contact.save();
  }
  return contact;
}

export async function reresolveContact(id) {
  const contact = await WhatsAppContact.findById(assertObjectId(id, "contact id"));
  if (!contact) throw notFound("Contact not found");
  const refs = await resolveSources(contact.normalizedPhone);
  contact.sourceReferences = refs;
  contact.resolvedAt = new Date();
  if (!contact.displayName) contact.displayName = displayNameFrom(refs, contact.profileName);
  await contact.save();
  return contact.toObject();
}

export async function listContacts(query = {}) {
  const paging = parsePaging(query);
  const filter = {};
  const search = cleanString(query.search, 80);
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    const digits = search.replace(/\D/g, "");
    filter.$or = [{ displayName: rx }, { profileName: rx }, ...(digits.length >= 3 ? [{ normalizedPhone: new RegExp(escapeRegex(digits)) }] : [])];
  }
  if (query.tag) filter.tags = cleanString(query.tag, 40).toLowerCase();
  if (query.optOut === "true") filter.optOut = true;
  if (query.optOut === "false") filter.optOut = false;
  if (query.source) filter["sourceReferences.type"] = cleanString(query.source, 20);

  const [rows, total] = await Promise.all([
    WhatsAppContact.find(filter).sort({ updatedAt: -1 }).skip(paging.skip).limit(paging.limit).lean(),
    WhatsAppContact.countDocuments(filter),
  ]);
  return pageResult(rows, total, paging);
}

export async function getContact(id) {
  const contact = await WhatsAppContact.findById(assertObjectId(id, "contact id")).lean();
  if (!contact) throw notFound("Contact not found");
  const conversation = await WhatsAppConversation.findOne({ contactId: contact._id }).select("_id status").lean();
  return { ...contact, conversationId: conversation?._id || null, conversationStatus: conversation?.status || "" };
}

export async function createContact(body = {}, by = "master-admin") {
  const normalizedPhone = normalizeWaPhone(body.phone);
  if (!normalizedPhone) throw badRequest("Enter a valid WhatsApp number (10-digit mobile or with country code)");
  if (await WhatsAppContact.exists({ normalizedPhone })) throw badRequest("A contact with this number already exists");
  const refs = await resolveSources(normalizedPhone).catch(() => []);
  const contact = await WhatsAppContact.create({
    normalizedPhone,
    displayName: cleanString(body.displayName, 120) || displayNameFrom(refs, ""),
    email: cleanString(body.email, 200),
    tags: cleanTags(body.tags),
    notes: cleanString(body.notes, 2000),
    consentStatus: WA_CONSENT_STATUSES.includes(body.consentStatus) && body.consentStatus !== "opted_out" ? body.consentStatus : "unknown",
    sourceReferences: refs,
    resolvedAt: new Date(),
    createdBy: by,
    updatedBy: by,
  });
  return contact.toObject();
}

export async function updateContact(id, body = {}, by = "master-admin") {
  const $set = { updatedBy: by };
  if (body.displayName !== undefined) $set.displayName = cleanString(body.displayName, 120);
  if (body.email !== undefined) $set.email = cleanString(body.email, 200).toLowerCase();
  if (body.notes !== undefined) $set.notes = cleanString(body.notes, 2000);
  if (body.tags !== undefined) $set.tags = cleanTags(body.tags);
  if (body.consentStatus !== undefined) {
    if (!WA_CONSENT_STATUSES.includes(body.consentStatus)) throw badRequest("Invalid consent status");
    $set.consentStatus = body.consentStatus;
    if (body.consentStatus === "opted_out") Object.assign($set, { optOut: true, optOutAt: new Date() });
    if (body.consentStatus === "opted_in") Object.assign($set, { optOut: false, optInAt: new Date() });
  }
  const contact = await WhatsAppContact.findByIdAndUpdate(assertObjectId(id, "contact id"), { $set }, { returnDocument: "after", runValidators: true }).lean();
  if (!contact) throw notFound("Contact not found");
  if ($set.tags) await WhatsAppConversation.updateOne({ contactId: contact._id }, { $set: { tags: $set.tags } });
  return contact;
}

/** Used by STOP / START keywords and by the admin UI. */
export async function setOptOut(contactId, optOut) {
  const now = new Date();
  const $set = optOut
    ? { optOut: true, optOutAt: now, consentStatus: "opted_out" }
    : { optOut: false, optInAt: now, consentStatus: "opted_in" };
  return WhatsAppContact.findByIdAndUpdate(contactId, { $set }, { returnDocument: "after" }).lean();
}

export async function addContactTag(contactId, tag) {
  const clean = cleanTags([tag])[0];
  if (!clean) return;
  await WhatsAppContact.updateOne({ _id: contactId }, { $addToSet: { tags: clean } });
  await WhatsAppConversation.updateOne({ contactId }, { $addToSet: { tags: clean } });
}

export async function listTags() {
  return WhatsAppContact.distinct("tags");
}

export async function staffOptions() {
  const rows = await Staff.find({ softDelete: { $ne: true }, status: { $in: CURRENT_STAFF_STATUSES } })
    .select("personalDetails.fullName employmentDetails.designationName")
    .sort({ "personalDetails.fullName": 1 })
    .limit(500)
    .lean();
  return rows.map((s) => ({ _id: s._id, name: s.personalDetails?.fullName || "Staff", designation: s.employmentDetails?.designationName || "" }));
}
