import mongoose from "mongoose";
import { Course } from "./courses.model.js";
import { University } from "../universities/universities.model.js";

function toRow(doc) {
  const d = doc?.toObject ? doc.toObject() : doc;
  const semesters = Array.isArray(d.semesters) ? d.semesters : [];
  const subjectCount = semesters.reduce(
    (sum, sem) => sum + (Array.isArray(sem.subjects) ? sem.subjects.length : 0),
    0
  );
  return {
    ...d,
    _id: String(d._id),
    id: String(d._id),
    universityId: d.universityId ? String(d.universityId) : null,
    semesters,
    semesterCount: d.semesterCount || semesters.length || 0,
    subjectCount,
    durationDisplay: d.durationLabel || (d.durationMonths ? `${d.durationMonths} months` : "—"),
    universityLabel:
      d.universityShortName ||
      d.universityName ||
      (d.type === "Institute" ? "Grow Skills Tech" : "—"),
  };
}

function buildStats(rows) {
  return {
    total: rows.length,
    active: rows.filter((row) => row.status === "Active").length,
    inactive: rows.filter((row) => row.status === "Inactive").length,
    draft: rows.filter((row) => row.status === "Draft").length,
    university: rows.filter((row) => row.type === "University").length,
    institute: rows.filter((row) => row.type === "Institute").length,
    semesters: rows.reduce((sum, row) => sum + (row.semesterCount || 0), 0),
  };
}

async function attachUniversityMeta(payload) {
  if (payload.type !== "University" || !payload.universityId) {
    return {
      ...payload,
      universityId: null,
      universityName:
        payload.type === "Institute"
          ? payload.universityName || "Grow Skills Tech"
          : "",
      universityShortName:
        payload.type === "Institute"
          ? payload.universityShortName || "GST"
          : "",
    };
  }

  if (!mongoose.Types.ObjectId.isValid(payload.universityId)) {
    const err = new Error("Invalid university id");
    err.status = 400;
    throw err;
  }

  const uni = await University.findOne({
    _id: payload.universityId,
    softDelete: false,
  })
    .select("name shortName")
    .maxTimeMS(5000)
    .lean();

  if (!uni) {
    const err = new Error("University not found");
    err.status = 400;
    throw err;
  }

  return {
    ...payload,
    universityId: uni._id,
    universityName: uni.name,
    universityShortName: uni.shortName,
  };
}

export async function listCourses({
  search = "",
  status = "",
  type = "",
  universityId = "",
} = {}) {
  const query = { softDelete: false };

  if (status) query.status = status;
  if (type) query.type = type;

  if (universityId && mongoose.Types.ObjectId.isValid(universityId)) {
    const uni = await University.findOne({
      _id: universityId,
      softDelete: false,
    })
      .select("shortName name")
      .lean()
      .maxTimeMS(5000);

    const isGst =
      /^GST$/i.test(String(uni?.shortName || "")) ||
      /grow\s*skills/i.test(String(uni?.name || ""));

    if (isGst) {
      query.$or = [
        { universityId },
        { type: "Institute" },
        { universityShortName: "GST" },
        { universityId: null },
      ];
    } else {
      query.universityId = universityId;
    }
  }

  if (search) {
    const searchOr = [
      { name: { $regex: search, $options: "i" } },
      { code: { $regex: search, $options: "i" } },
      { universityName: { $regex: search, $options: "i" } },
      { universityShortName: { $regex: search, $options: "i" } },
      { category: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
    ];
    if (query.$or) {
      query.$and = [{ $or: query.$or }, { $or: searchOr }];
      delete query.$or;
    } else {
      query.$or = searchOr;
    }
  }

  const docs = await Course.find(query).sort({ name: 1 }).lean().maxTimeMS(8000);
  const rows = docs.map(toRow);
  return { rows, stats: buildStats(rows) };
}

export async function getCourseById(id) {
  const doc = await Course.findOne({ _id: id, softDelete: false }).lean();
  return doc ? toRow(doc) : null;
}

export async function createCourse(payload) {
  const withMeta = await attachUniversityMeta(payload);
  const created = await Course.create(withMeta);
  return toRow(created);
}

export async function updateCourse(id, payload) {
  const existing = await Course.findOne({ _id: id, softDelete: false })
    .maxTimeMS(5000)
    .lean();
  if (!existing) return null;

  const withMeta = await attachUniversityMeta(payload);
  const updated = await Course.findOneAndUpdate(
    { _id: id, softDelete: false },
    withMeta,
    { returnDocument: "after", maxTimeMS: 5000 }
  );

  return updated ? toRow(updated) : null;
}

export async function deactivateCourse(id, updatedBy) {
  const existing = await Course.findOne({ _id: id, softDelete: false })
    .maxTimeMS(5000)
    .lean();
  if (!existing) return null;

  const updated = await Course.findOneAndUpdate(
    { _id: id, softDelete: false },
    { status: "Inactive", updatedBy },
    { returnDocument: "after", maxTimeMS: 5000 }
  );

  return updated ? toRow(updated) : null;
}

export async function activateCourse(id, updatedBy) {
  const existing = await Course.findOne({ _id: id, softDelete: false })
    .maxTimeMS(5000)
    .lean();
  if (!existing) return null;

  const updated = await Course.findOneAndUpdate(
    { _id: id, softDelete: false },
    { status: "Active", updatedBy },
    { returnDocument: "after", maxTimeMS: 5000 }
  );

  return updated ? toRow(updated) : null;
}
