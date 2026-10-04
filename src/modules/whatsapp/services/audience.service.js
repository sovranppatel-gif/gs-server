import mongoose from "mongoose";
import { Admission } from "../../../models/Admission.js";
import { Staff } from "../../staff/staff.model.js";
import { Faculty } from "../../faculties/faculty.model.js";
import { Lead, LEAD_SOURCES, LEAD_STATUSES } from "../../leads/leads.model.js";
import { Enquiry } from "../../enquiries/enquiries.model.js";
import { Batch } from "../../batches/batches.model.js";
import { Course } from "../../courses/courses.model.js";
import { WhatsAppContact } from "../models/whatsappContact.model.js";
import { normalizeWaPhone } from "../whatsapp.phone.js";
import { CURRENT_STAFF_STATUSES, badRequest, cleanString } from "../whatsapp.utils.js";

/**
 * Builds campaign audiences straight from the existing modules' collections
 * (read-only, projected). No per-audience WhatsApp copies are created.
 */
export const AUDIENCE_SOURCES = Object.freeze(["students", "course", "batch", "staff", "faculty", "leads", "enquiries", "contacts", "custom"]);
const MAX_AUDIENCE = 20000;
const Q_TIMEOUT = 15000;

async function batchKeys(batchId) {
  if (!mongoose.isValidObjectId(batchId)) throw badRequest("Select a batch");
  const batch = await Batch.findById(batchId).select("batchId name courseName").lean();
  if (!batch) throw badRequest("Batch not found");
  return { batch, keys: [String(batch._id), batch.batchId].filter(Boolean) };
}

async function studentRows(filters = {}) {
  const query = { softDelete: { $ne: true }, status: filters.status || "Approved" };
  let batchName = "";
  if (filters.course) query.course = cleanString(filters.course, 200);
  if (filters.batchId) {
    const { batch, keys } = await batchKeys(filters.batchId);
    batchName = batch.name;
    query.$or = [{ "details.batchId": { $in: keys } }, { "details.batchMongoId": { $in: keys } }, { "details.seedBatchId": { $in: keys } }];
  }
  const rows = await Admission.find(query).select("applicant phone course").sort({ admissionDate: -1 }).limit(MAX_AUDIENCE).maxTimeMS(Q_TIMEOUT).lean();
  return rows.map((a) => ({ phone: a.phone, name: a.applicant, course: a.course, batch: batchName, sourceType: "admission", sourceId: String(a._id) }));
}

async function rowsFor(audience) {
  const f = audience.filters || {};
  switch (audience.source) {
    case "students":
      return studentRows(f);
    case "course":
      if (!f.course) throw badRequest("Select a course");
      return studentRows({ course: f.course });
    case "batch":
      if (!f.batchId) throw badRequest("Select a batch");
      return studentRows({ batchId: f.batchId });
    case "staff": {
      const rows = await Staff.find({ softDelete: { $ne: true }, status: { $in: CURRENT_STAFF_STATUSES } })
        .select("personalDetails.fullName personalDetails.personalMobile personalDetails.whatsapp")
        .limit(MAX_AUDIENCE)
        .maxTimeMS(Q_TIMEOUT)
        .lean();
      return rows.map((s) => ({
        phone: s.personalDetails?.whatsapp || s.personalDetails?.personalMobile,
        name: s.personalDetails?.fullName || "",
        sourceType: "staff",
        sourceId: String(s._id),
      }));
    }
    case "faculty": {
      const rows = await Faculty.find({ softDelete: { $ne: true }, status: "Active" })
        .select("personalDetails.fullName personalDetails.mobile assignedCourses")
        .limit(MAX_AUDIENCE)
        .maxTimeMS(Q_TIMEOUT)
        .lean();
      return rows.map((x) => ({ phone: x.personalDetails?.mobile, name: x.personalDetails?.fullName || "", course: (x.assignedCourses || [])[0] || "", sourceType: "faculty", sourceId: String(x._id) }));
    }
    case "leads": {
      const query = {};
      if (f.status && LEAD_STATUSES.includes(f.status)) query.status = f.status;
      if (f.source && LEAD_SOURCES.includes(f.source)) query.source = f.source;
      const rows = await Lead.find(query).select("name phone interest").sort({ createdAt: -1 }).limit(MAX_AUDIENCE).maxTimeMS(Q_TIMEOUT).lean();
      return rows.map((l) => ({ phone: l.phone, name: l.name, course: l.interest || "", sourceType: "lead", sourceId: String(l._id) }));
    }
    case "enquiries": {
      const query = { mobile: { $nin: ["", null] } };
      if (["client", "student"].includes(f.enquiryType)) query.enquiryType = f.enquiryType;
      if (f.allowUpdatesOnly !== false) query.allowUpdates = true; // respect the enquiry form's consent checkbox by default
      const rows = await Enquiry.find(query).select("fullName mobile courseRequested serviceRequested").sort({ submittedAt: -1 }).limit(MAX_AUDIENCE).maxTimeMS(Q_TIMEOUT).lean();
      return rows.map((e) => ({ phone: e.mobile, name: e.fullName, course: e.courseRequested || e.serviceRequested || "", sourceType: "enquiry", sourceId: String(e._id) }));
    }
    case "contacts": {
      const query = { optOut: false };
      if (f.tag) query.tags = cleanString(f.tag, 40).toLowerCase();
      const rows = await WhatsAppContact.find(query).select("normalizedPhone displayName profileName").limit(MAX_AUDIENCE).maxTimeMS(Q_TIMEOUT).lean();
      return rows.map((c) => ({ phone: c.normalizedPhone, name: c.displayName || c.profileName || "", sourceType: "contact", sourceId: String(c._id) }));
    }
    case "custom": {
      const lines = String(f.numbers || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) throw badRequest("Paste at least one number");
      if (lines.length > MAX_AUDIENCE) throw badRequest(`Maximum ${MAX_AUDIENCE} numbers per campaign`);
      return lines.map((line) => {
        // "Name, 98765…" or just "98765…"
        const parts = line.split(/[,\t;]/).map((p) => p.trim());
        const phonePart = parts.find((p) => p.replace(/\D/g, "").length >= 10) || parts[parts.length - 1];
        const name = parts.filter((p) => p !== phonePart).join(" ");
        return { phone: phonePart, name, sourceType: "custom", sourceId: "" };
      });
    }
    default:
      throw badRequest("Select an audience");
  }
}

/** Normalise → de-duplicate → drop opted-out. Returns sendable rows + exclusion counts. */
export async function resolveAudience(audience = {}) {
  if (!AUDIENCE_SOURCES.includes(audience.source)) throw badRequest("Select an audience");
  const raw = await rowsFor(audience);
  const seen = new Set();
  const unique = [];
  let invalid = 0;
  let duplicates = 0;
  const invalidSamples = [];
  for (const row of raw) {
    const phone = normalizeWaPhone(row.phone);
    if (!phone) {
      invalid += 1;
      if (invalidSamples.length < 10) invalidSamples.push({ name: row.name || "", phone: String(row.phone || "") });
      continue;
    }
    if (seen.has(phone)) {
      duplicates += 1;
      continue;
    }
    seen.add(phone);
    unique.push({ ...row, phone, name: cleanString(row.name, 120), course: cleanString(row.course, 200), batch: cleanString(row.batch, 120) });
  }

  const optedOut = new Set();
  const phones = unique.map((r) => r.phone);
  for (let i = 0; i < phones.length; i += 5000) {
    const rows = await WhatsAppContact.find({ normalizedPhone: { $in: phones.slice(i, i + 5000) }, optOut: true }).select("normalizedPhone").lean();
    rows.forEach((r) => optedOut.add(r.normalizedPhone));
  }
  const rows = unique.filter((r) => !optedOut.has(r.phone));
  return {
    rows,
    stats: { total: raw.length, sendable: rows.length, invalid, duplicates, optedOut: optedOut.size },
    invalidSamples,
  };
}

export function describeAudience(audience = {}) {
  const f = audience.filters || {};
  const bits = {
    students: `Students${f.course ? ` · ${f.course}` : ""}`,
    course: `Course · ${f.course || ""}`,
    batch: "Batch",
    staff: "Active staff",
    faculty: "Active faculty",
    leads: `Leads${f.status ? ` · ${f.status}` : ""}${f.source ? ` · ${f.source}` : ""}`,
    enquiries: `Enquiries${f.enquiryType ? ` · ${f.enquiryType}` : ""}${f.allowUpdatesOnly !== false ? " · opted-in only" : ""}`,
    contacts: `WhatsApp contacts${f.tag ? ` · #${f.tag}` : ""}`,
    custom: "Custom numbers",
  };
  return bits[audience.source] || audience.source || "";
}

export async function audienceOptions() {
  const [admissionCourses, courses, batches, tags] = await Promise.all([
    Admission.distinct("course", { softDelete: { $ne: true }, status: "Approved" }),
    Course.find({ softDelete: { $ne: true }, status: "Active" }).select("name").sort({ name: 1 }).limit(500).lean(),
    Batch.find({ softDelete: { $ne: true }, status: { $ne: "Archived" } }).select("name courseName status batchId").sort({ startDate: -1 }).limit(500).lean(),
    WhatsAppContact.distinct("tags"),
  ]);
  return {
    sources: AUDIENCE_SOURCES,
    courses: [...new Set([...admissionCourses, ...courses.map((c) => c.name)].filter(Boolean))].sort(),
    batches: batches.map((b) => ({ _id: b._id, label: `${b.name}${b.courseName ? ` · ${b.courseName}` : ""}`, status: b.status })),
    leadStatuses: LEAD_STATUSES,
    leadSources: LEAD_SOURCES,
    tags: tags.filter(Boolean).sort(),
  };
}
