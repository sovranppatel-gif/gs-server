import { Router } from "express";
import mongoose from "mongoose";
import { Admission } from "../models/Admission.js";
import { requireMasterAdminJwt } from "../middleware/requireMasterAdminJwt.js";

const router = Router();

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slimDetails(details = {}) {
  if (!details || typeof details !== "object") return {};
  const out = {};
  out.courseId = details.courseId || details.courseId || "";
  out.universityId = details.universityId || "";
  out.batchId = details.batchId || details.seedBatchId || "";
  out.session = details.session || details.sessionKey || "";
  out.currentSemester = details.currentSemester || details.semester || null;
  out.gender = details.gender || "";
  out.category = details.category || "";
  out.hasPhoto = Boolean(details.photoPreview || details.photo);
  return out;
}

function toListRow(doc) {
  const d = doc;
  return {
    id: String(d._id),
    admissionId: d.admissionId,
    name: d.applicant,
    email: d.email,
    mobile: d.phone,
    course: d.course || "",
    college: d.college || "",
    status: d.status || "",
    admissionDate: d.admissionDate || d.createdAt || null,
    details: slimDetails(d.details),
  };
}

// Protected master-admin endpoints
router.use(requireMasterAdminJwt);

/**
 * GET /api/master-admin/students
 * Query params: page, limit, search, status, courseId, universityId, batchId, session, term, gender, category, sortBy, sortOrder
 */
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const skip = (page - 1) * limit;

    const q = [];

    const { search } = req.query;
    if (search && String(search).trim()) {
      const s = String(search).trim();
      const rx = new RegExp(escapeRegex(s), "i");
      q.push({ $or: [
        { applicant: rx },
        { admissionId: rx },
        { email: rx },
        { phone: rx },
        { "details.registrationNo": rx },
      ] });
    }

    if (req.query.status) q.push({ status: String(req.query.status).trim() });
    if (req.query.courseId) q.push({ $or: [{ "details.courseId": String(req.query.courseId) }, { course: new RegExp(escapeRegex(String(req.query.courseId)), "i") }] });
    if (req.query.universityId) q.push({ $or: [{ "details.universityId": String(req.query.universityId) }, { college: new RegExp(escapeRegex(String(req.query.universityId)), "i") }] });
    if (req.query.batchId) q.push({ $or: [{ "details.batchId": String(req.query.batchId) }, { "details.seedBatchId": String(req.query.batchId) }] });
    if (req.query.session) q.push({ $or: [{ sessionKey: String(req.query.session).trim().toUpperCase() }, { "details.session": String(req.query.session).trim() }] });
    if (req.query.term) q.push({ $or: [{ "details.currentSemester": Number(req.query.term) }, { "details.semester": Number(req.query.term) }] });
    if (req.query.gender) q.push({ "details.gender": String(req.query.gender).trim() });
    if (req.query.category) q.push({ "details.category": String(req.query.category).trim() });

    const filter = q.length ? { $and: q } : {};

    // Whitelist sortable fields
    const sortMap = {
      admissionDate: { admissionDate: -1 },
      applicant: { applicant: 1 },
      admissionId: { admissionId: -1 },
      status: { status: 1 },
    };
    const sortBy = String(req.query.sortBy || "admissionDate");
    const sortOrder = String(req.query.sortOrder || "desc");
    const sort = sortMap[sortBy] || { admissionDate: -1 };

    const projection = "admissionId applicant email phone course college status admissionDate details";

    const [total, docs] = await Promise.all([
      Admission.countDocuments(filter).maxTimeMS(8000),
      Admission.find(filter)
        .select(projection)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean()
        .maxTimeMS(12000),
    ]);

    const items = docs.map(toListRow);
    return res.json({ success: true, items, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("master-admin students list error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch students" });
  }
});

/** GET /api/master-admin/students/stats — lightweight counts */
router.get("/stats", async (req, res) => {
  try {
    const total = await Admission.countDocuments({}).maxTimeMS(8000);
    const byStatusAgg = await Admission.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $project: { _id: 0, status: "$_id", count: 1 } },
    ]).maxTimeMS(8000);

    const byCourseAgg = await Admission.aggregate([
      { $group: { _id: "$details.courseId", count: { $sum: 1 } } },
      { $project: { _id: 0, courseId: "$_id", count: 1 } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]).maxTimeMS(8000);

    return res.json({ success: true, total, byStatus: byStatusAgg, byCourse: byCourseAgg });
  } catch (err) {
    console.error("master-admin students stats error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch students stats" });
  }
});

/** GET /api/master-admin/students/:id — admission detail (by Mongo id or admissionId) */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let entry = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
      entry = await Admission.findById(id).lean().maxTimeMS(8000);
    }
    if (!entry) {
      entry = await Admission.findOne({ admissionId: id }).lean().maxTimeMS(8000);
    }
    if (!entry) return res.status(404).json({ success: false, message: "Student not found" });

    // Minimal mapping similar to existing toRow
    const details = entry.details && typeof entry.details === "object" ? entry.details : {};
    const out = {
      id: String(entry._id),
      admissionId: entry.admissionId,
      name: entry.applicant,
      email: entry.email,
      mobile: entry.phone,
      course: entry.course,
      college: entry.college,
      status: entry.status,
      admissionDate: entry.admissionDate,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      details,
    };
    return res.json({ success: true, entry: out });
  } catch (err) {
    console.error("master-admin student get error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch student" });
  }
});

export default router;
