import mongoose from "mongoose";
import { WorkshopRegistration, WorkshopReferralLink } from "./workshop.model.js";
import { University } from "../universities/universities.model.js";
import { reserveNextSequence } from "../../lib/sequence.js";
import { slugifyReferralCode } from "./workshop.validation.js";

/**
 * Atomic sequence via the existing Counter/reserveNextSequence utility
 * (same pattern as staff.service.js's employeeId) — avoids the race
 * condition a plain "find latest, +1" approach would have under
 * concurrent public submissions.
 */
async function getNextRegistrationId() {
  const seq = await reserveNextSequence({
    key: "workshop-registration",
    readMax: async () => {
      const [result] = await WorkshopRegistration.aggregate([
        { $match: { registrationId: { $regex: "^GST-W-[0-9]+$" } } },
        {
          $project: {
            seq: {
              $convert: {
                input: { $substrCP: ["$registrationId", 6, 20] },
                to: "int",
                onError: 0,
                onNull: 0,
              },
            },
          },
        },
        { $group: { _id: null, maxSeq: { $max: "$seq" } } },
      ]);
      return result?.maxSeq || 0;
    },
  });
  return `GST-W-${String(seq).padStart(6, "0")}`;
}

/**
 * There's only one workshop right now (no workshopId field), so this scans
 * the whole collection rather than a short time window — a student who
 * already registered yesterday should still be told "already registered"
 * today, not create a second row. If a second workshop is ever added, scope
 * this by a workshopId the same way the collection would need one added.
 */
async function findExistingRegistration(payload) {
  const email = payload.email;
  const mobile = payload.mobile;

  if (!email || !mobile) return null;

  const existing = await WorkshopRegistration.findOne({
    email,
    mobile,
  })
    .sort({ createdAt: -1 })
    .lean();

  return existing || null;
}

export async function createWorkshopRegistration(payload) {
  const duplicate = await findExistingRegistration(payload);
  if (duplicate) {
    return {
      success: false,
      isDuplicate: true,
      message: "You are already registered for this workshop.",
      entry: duplicate,
    };
  }

  const registrationId = await getNextRegistrationId();

  const registration = await WorkshopRegistration.create({
    registrationId,
    ...payload,
  });

  console.log(
    `[workshop] Registration created: ${registration.registrationId} | Email: ${registration.email} | Referral: ${registration.referralCode}`
  );

  return {
    success: true,
    isDuplicate: false,
    message: "Registration submitted successfully",
    entry: registration.toObject(),
  };
}

export async function getAllWorkshopRegistrations(filters = {}) {
  const query = {};

  if (filters.status) {
    query.status = filters.status;
  }

  if (filters.referralCode) {
    query.referralCode = filters.referralCode.toUpperCase();
  }

  if (filters.universityId) {
    if (mongoose.isValidObjectId(filters.universityId)) {
      query.universityId = filters.universityId;
    }
  }

  if (filters.course) {
    query.course = filters.course;
  }

  if (filters.semesterYear) {
    query.semesterYear = filters.semesterYear;
  }

  if (filters.search) {
    query.$or = [
      { fullName: { $regex: filters.search, $options: "i" } },
      { email: { $regex: filters.search, $options: "i" } },
      { mobile: { $regex: filters.search, $options: "i" } },
      { registrationId: { $regex: filters.search, $options: "i" } },
    ];
  }

  const registrations = await WorkshopRegistration.find(query)
    .sort({ createdAt: -1 })
    .lean();

  return registrations;
}

export async function getWorkshopRegistrationById(id) {
  if (!mongoose.isValidObjectId(id)) {
    return null;
  }

  return await WorkshopRegistration.findById(id).lean();
}

export async function updateWorkshopRegistration(id, payload) {
  if (!mongoose.isValidObjectId(id)) {
    return null;
  }

  const updated = await WorkshopRegistration.findByIdAndUpdate(
    id,
    { $set: payload },
    { returnDocument: "after", runValidators: true }
  ).lean();

  return updated;
}

export async function deleteWorkshopRegistration(id) {
  if (!mongoose.isValidObjectId(id)) {
    return null;
  }

  return await WorkshopRegistration.findByIdAndDelete(id);
}

export async function getReferralSummary() {
  const pipeline = [
    {
      $group: {
        _id: "$referralCode",
        count: { $sum: 1 },
      },
    },
    {
      $sort: { count: -1 },
    },
  ];

  const summary = await WorkshopRegistration.aggregate(pipeline);

  const totalCount = await WorkshopRegistration.countDocuments();

  return {
    total: totalCount,
    byReferral: summary,
  };
}

export async function getUniqueCourses() {
  const courses = await WorkshopRegistration.distinct("course");
  return courses.sort();
}

export async function getUniqueSemesterYears() {
  const years = await WorkshopRegistration.distinct("semesterYear");
  return years;
}

export async function getUniqueReferralCodes() {
  const codes = await WorkshopRegistration.distinct("referralCode", {
    referralCode: { $ne: null },
  });
  return codes.sort();
}

/**
 * Read-only lookup for the public workshop form's college dropdown.
 * Does NOT modify the University module — reuses the same model in a
 * minimal, projected query so the workshop page (which has no admin JWT)
 * can list active colleges without touching /api/universities' auth-gated
 * routes or controller.
 */
export async function getActiveUniversitiesForDropdown() {
  const universities = await University.find(
    { status: "Active", softDelete: false },
    { name: 1, shortName: 1, city: 1, state: 1 }
  )
    .sort({ name: 1 })
    .lean();

  return universities;
}

function normalizeWorkshopDetails({ workshopName, workshopPlace, workshopDate, workshopStartDate, workshopEndDate, startTime, endTime }) {
  return {
    workshopName: String(workshopName || "Skills Enhance Workshop").trim(),
    workshopPlace: String(workshopPlace || "").trim(),
    workshopStartDate: String(workshopStartDate || workshopDate || "").trim(),
    workshopEndDate: String(workshopEndDate || workshopDate || "").trim(),
    startTime: String(startTime || "").trim(),
    endTime: String(endTime || "").trim(),
  };
}

export async function createReferralLink({ collegeName, referralCode, createdBy, workshopName, workshopPlace, workshopDate, workshopStartDate, workshopEndDate, startTime, endTime }) {
  const name = String(collegeName || "").trim();
  if (!name) {
    const err = new Error("College name is required");
    err.code = "VALIDATION";
    throw err;
  }

  const code = String(referralCode || slugifyReferralCode(name))
    .trim()
    .toUpperCase();

  if (!code) {
    const err = new Error("Unable to generate a referral code from this college name");
    err.code = "VALIDATION";
    throw err;
  }

  const existing = await WorkshopReferralLink.findOne({ referralCode: code }).lean();
  if (existing) {
    const err = new Error(`Referral code "${code}" already exists for ${existing.collegeName}`);
    err.code = "DUPLICATE";
    throw err;
  }

  const link = await WorkshopReferralLink.create({
    collegeName: name,
    referralCode: code,
    createdBy: createdBy || "master-admin",
    ...normalizeWorkshopDetails({ workshopName, workshopPlace, workshopDate, workshopStartDate, workshopEndDate, startTime, endTime }),
  });

  return link.toObject();
}

export async function updateReferralLink(id, payload) {
  if (!mongoose.isValidObjectId(id)) return null;

  const updates = normalizeWorkshopDetails(payload);
  if (payload.collegeName !== undefined) {
    const collegeName = String(payload.collegeName || "").trim();
    if (!collegeName) {
      const err = new Error("College name is required");
      err.code = "VALIDATION";
      throw err;
    }
    updates.collegeName = collegeName;
  }

  return WorkshopReferralLink.findByIdAndUpdate(id, { $set: updates }, { new: true }).lean();
}

export async function getReferralLinkByCode(referralCode) {
  const code = String(referralCode || "").trim().toUpperCase();
  if (!code) return null;
  return WorkshopReferralLink.findOne({ referralCode: code }).lean();
}

export async function getAllReferralLinks() {
  const links = await WorkshopReferralLink.find().sort({ createdAt: -1 }).lean();

  const counts = await WorkshopRegistration.aggregate([
    { $match: { referralCode: { $ne: null } } },
    { $group: { _id: "$referralCode", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [c._id, c.count]));

  return links.map((link) => ({
    ...link,
    registrationCount: countMap.get(link.referralCode) || 0,
  }));
}

export async function deleteReferralLink(id) {
  if (!mongoose.isValidObjectId(id)) {
    return null;
  }
  return await WorkshopReferralLink.findByIdAndDelete(id);
}
