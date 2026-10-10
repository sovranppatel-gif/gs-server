import { Router } from "express";
import mongoose from "mongoose";
import { Admission } from "../models/Admission.js";
import { requireMasterAdminJwt } from "../middleware/requireMasterAdminJwt.js";
import { Course } from "../modules/courses/courses.model.js";
import { AcademicDepartment } from "../modules/academicDepartments/academicDepartment.model.js";
import { buildDepartmentStudentFilter } from "../modules/academicDepartments/academicDepartment.service.js";

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

/** Department is derived Admission → Course → AcademicDepartment (never
 * stored on the admission). Matches by details.courseId, falling back to the
 * course name for legacy rows without an id (only when that name is unique
 * in the catalog). Returns a function admission → dept info | null. */
async function departmentResolverFor(admissions) {
  const ids = new Set();
  const names = new Set();
  for (const a of admissions) {
    const cid = String(a.details?.courseId || "");
    if (mongoose.Types.ObjectId.isValid(cid)) ids.add(cid);
    else if (a.course) names.add(String(a.course).trim().toLowerCase());
  }
  if (!ids.size && !names.size) return () => null;

  const nameRegexes = [...names].map((n) => new RegExp(`^\\s*${escapeRegex(n)}\\s*$`, "i"));
  const or = [];
  if (ids.size) or.push({ _id: { $in: [...ids] } });
  if (nameRegexes.length) or.push({ name: { $in: nameRegexes } });
  const courses = await Course.find({ softDelete: false, $or: or }).select("name departmentId").lean();

  const deptIds = courses.map((c) => c.departmentId).filter(Boolean);
  const depts = deptIds.length
    ? await AcademicDepartment.find({ _id: { $in: deptIds } }).select("name code").lean()
    : [];
  const deptById = new Map(depts.map((d) => [String(d._id), d]));
  const info = (deptId) => {
    const d = deptId ? deptById.get(String(deptId)) : null;
    return d ? { departmentId: String(d._id), departmentName: d.name, departmentCode: d.code } : null;
  };

  const byCourseId = new Map(courses.map((c) => [String(c._id), info(c.departmentId)]));
  const byName = new Map();
  const ambiguous = new Set();
  for (const c of courses) {
    const key = String(c.name || "").trim().toLowerCase();
    if (byName.has(key)) ambiguous.add(key);
    byName.set(key, info(c.departmentId));
  }
  for (const key of ambiguous) byName.delete(key);

  return (a) => {
    const cid = String(a.details?.courseId || "");
    if (cid) return byCourseId.get(cid) || null;
    return byName.get(String(a.course || "").trim().toLowerCase()) || null;
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
    if (req.query.departmentId) {
      const deptFilter = await buildDepartmentStudentFilter(String(req.query.departmentId));
      // No courses linked (or invalid id) → the department has no students.
      // Archived admissions are not department students, matching the
      // counts on the Academic Department pages.
      q.push(deptFilter ? { ...deptFilter, softDelete: { $ne: true } } : { _id: { $in: [] } });
    }

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

    const resolveDept = await departmentResolverFor(docs);
    const items = docs.map((d) => {
      const row = toListRow(d);
      const dept = resolveDept(d);
      return { ...row, departmentId: dept?.departmentId || "", departmentName: dept?.departmentName || "" };
    });
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
    ]).option({ maxTimeMS: 8000 });

    const byCourseAgg = await Admission.aggregate([
      { $group: { _id: "$details.courseId", count: { $sum: 1 } } },
      { $project: { _id: 0, courseId: "$_id", count: 1 } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]).option({ maxTimeMS: 8000 });

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
    const dept = (await departmentResolverFor([entry]))(entry);
    out.departmentId = dept?.departmentId || "";
    out.departmentName = dept?.departmentName || "";
    return res.json({ success: true, entry: out });
  } catch (err) {
    console.error("master-admin student get error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch student" });
  }
});

export default router;
