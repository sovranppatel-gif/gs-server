import mongoose from "mongoose";
import { AcademicDepartment, ACADEMIC_DEPARTMENT_STATUSES } from "./academicDepartment.model.js";
import { normalizeDepartmentName } from "./academicDepartment.validation.js";
import { Faculty } from "../faculties/faculty.model.js";
import { Course } from "../courses/courses.model.js";
import { Batch } from "../batches/batches.model.js";
import { Admission } from "../../models/Admission.js";
import { createActivityLog } from "../activityLog/activityLog.service.js";

const SECTION = "Academic Departments";
const BASE_PATH = "/api/academic-departments";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
const notFound = (m) => httpError(404, m);
const badRequest = (m) => httpError(400, m);
const conflict = (m) => httpError(409, m);

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function asObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const raw = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(raw) || raw.length !== 24) return null;
  return new mongoose.Types.ObjectId(raw);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

async function logActivity(action, doc, editor, message, path = `${BASE_PATH}/${doc._id}`) {
  try {
    await createActivityLog({
      section: SECTION,
      action,
      actor: editor,
      resourceId: String(doc._id),
      message,
      path,
    });
  } catch (err) {
    // Audit logging must never fail the actual write.
    console.error("academic department activity log failed:", err?.message || err);
  }
}

function hodSummary(f) {
  if (!f) return null;
  return {
    _id: String(f._id),
    facultyId: f.facultyId || "",
    name: f.personalDetails?.fullName || "",
    designation: f.employmentDetails?.designation || "",
    email: f.personalDetails?.email || "",
    status: f.status || "",
  };
}

function toRow(doc, { hod = null, counts = null } = {}) {
  return {
    _id: String(doc._id),
    name: doc.name,
    code: doc.code,
    shortName: doc.shortName || "",
    description: doc.description || "",
    email: doc.email || "",
    phone: doc.phone || "",
    status: doc.status,
    establishedYear: doc.establishedYear ?? null,
    capacity: doc.capacity ?? null,
    hodId: doc.hod ? String(doc.hod) : "",
    hod,
    hodName: hod?.name || "",
    counts: counts || { faculty: 0, activeFaculty: 0, courses: 0, activeCourses: 0, students: 0 },
    createdBy: doc.createdBy || "",
    updatedBy: doc.updatedBy || "",
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function loadHods(docs) {
  const ids = docs.map((d) => d.hod).filter(Boolean);
  if (!ids.length) return new Map();
  const faculty = await Faculty.find({ _id: { $in: ids } })
    .select("facultyId personalDetails.fullName personalDetails.email employmentDetails.designation status softDelete")
    .lean();
  return new Map(faculty.map((f) => [String(f._id), hodSummary(f)]));
}

async function findDepartmentDoc(id) {
  const oid = asObjectId(id);
  if (!oid) throw badRequest("Invalid department id");
  const doc = await AcademicDepartment.findOne({ _id: oid, softDelete: false });
  if (!doc) throw notFound("Academic department not found");
  return doc;
}

// ---------------------------------------------------------------------------
// Course index + student derivation
//
// Students are Admission documents. An admission stores its course as
// details.courseId (string of Course._id — see routes/admissions.routes.js);
// a few legacy rows only carry the course *name* in `course`. Department is
// therefore derived Admission → Course → AcademicDepartment, never stored on
// the admission itself.
// ---------------------------------------------------------------------------

/** Only Approved, non-archived admissions count as enrolled students — the
 * same default the Master Admin Students page applies. */
const ENROLLED_STUDENT_MATCH = { status: "Approved", softDelete: { $ne: true } };

async function loadCourseIndex() {
  const courses = await Course.find({ softDelete: false })
    .select("name code status departmentId")
    .lean()
    .maxTimeMS(8000);

  const deptByCourseId = new Map();
  // Name → department, only kept when every course with that name sits in the
  // same department; ambiguous names are never used to attribute students.
  const deptByCourseName = new Map();
  const ambiguousNames = new Set();
  for (const c of courses) {
    const deptId = c.departmentId ? String(c.departmentId) : null;
    deptByCourseId.set(String(c._id), deptId);
    const key = String(c.name || "").trim().toLowerCase();
    if (!key) continue;
    if (deptByCourseName.has(key) && deptByCourseName.get(key) !== deptId) ambiguousNames.add(key);
    else deptByCourseName.set(key, deptId);
  }
  for (const key of ambiguousNames) deptByCourseName.delete(key);
  return { courses, deptByCourseId, deptByCourseName };
}

/** Mongo filter selecting the enrolled admissions of the given courses. */
function studentMatchForCourses(courses, deptByCourseName, deptId) {
  if (!courses.length) return null;
  const idVariants = [];
  for (const c of courses) idVariants.push(String(c._id), c._id);
  const nameRegexes = courses
    .map((c) => String(c.name || "").trim())
    .filter((name) => name && deptByCourseName.get(name.toLowerCase()) === deptId)
    .map((name) => new RegExp(`^\\s*${escapeRegex(name)}\\s*$`, "i"));

  const or = [{ "details.courseId": { $in: idVariants } }];
  if (nameRegexes.length) {
    or.push({ "details.courseId": { $in: [null, ""] }, course: { $in: nameRegexes } });
  }
  return { ...ENROLLED_STUDENT_MATCH, $or: or };
}

/**
 * Admission filter for "students of this department" — exported for the
 * Master Admin students list (routes/masterAdmin.students.routes.js).
 * Returns null when the department has no courses (i.e. no students).
 */
export async function buildDepartmentStudentFilter(departmentId) {
  const deptOid = asObjectId(departmentId);
  if (!deptOid) return null;
  const index = await loadCourseIndex();
  const deptId = String(deptOid);
  const courses = index.courses.filter((c) => String(c.departmentId || "") === deptId);
  const match = studentMatchForCourses(courses, index.deptByCourseName, deptId);
  if (!match) return null;
  // Callers add their own status/softDelete filters.
  return { $or: match.$or };
}

/** Enrolled students per department id, from one grouped aggregation. */
async function countStudentsByDepartment(index) {
  const linked = index.courses.filter((c) => c.departmentId);
  if (!linked.length) return new Map();

  const idVariants = [];
  for (const c of linked) idVariants.push(String(c._id), c._id);
  const nameRegexes = [...index.deptByCourseName.entries()]
    .filter(([, deptId]) => deptId)
    .map(([name]) => new RegExp(`^\\s*${escapeRegex(name)}\\s*$`, "i"));

  const or = [{ "details.courseId": { $in: idVariants } }];
  if (nameRegexes.length) or.push({ "details.courseId": { $in: [null, ""] }, course: { $in: nameRegexes } });

  const groups = await Admission.aggregate([
    { $match: { ...ENROLLED_STUDENT_MATCH, $or: or } },
    {
      $group: {
        _id: {
          cid: { $toString: "$details.courseId" },
          cname: { $toLower: { $trim: { input: { $ifNull: ["$course", ""] } } } },
        },
        n: { $sum: 1 },
      },
    },
  ]).option({ maxTimeMS: 10000 });

  const out = new Map();
  for (const g of groups) {
    const cid = g._id.cid || "";
    const deptId = cid ? index.deptByCourseId.get(cid) : index.deptByCourseName.get(g._id.cname);
    if (!deptId) continue;
    out.set(deptId, (out.get(deptId) || 0) + g.n);
  }
  return out;
}

async function countFacultyByDepartment(deptOids) {
  const groups = await Faculty.aggregate([
    { $match: { softDelete: false, "employmentDetails.departmentId": { $in: deptOids } } },
    {
      $group: {
        _id: "$employmentDetails.departmentId",
        total: { $sum: 1 },
        active: { $sum: { $cond: [{ $eq: ["$status", "Active"] }, 1, 0] } },
      },
    },
  ]).option({ maxTimeMS: 8000 });
  return new Map(groups.map((g) => [String(g._id), { total: g.total, active: g.active }]));
}

async function buildCounts(deptDocs) {
  if (!deptDocs.length) return new Map();
  const deptOids = deptDocs.map((d) => d._id);
  const [index, facultyMap] = await Promise.all([loadCourseIndex(), countFacultyByDepartment(deptOids)]);
  const studentMap = await countStudentsByDepartment(index);

  const out = new Map();
  for (const d of deptDocs) {
    const id = String(d._id);
    const courses = index.courses.filter((c) => String(c.departmentId || "") === id);
    out.set(id, {
      faculty: facultyMap.get(id)?.total || 0,
      activeFaculty: facultyMap.get(id)?.active || 0,
      courses: courses.length,
      activeCourses: courses.filter((c) => c.status === "Active").length,
      students: studentMap.get(id) || 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared guards used by the Faculty and Course modules
// ---------------------------------------------------------------------------

/**
 * Validates a department chosen on a Faculty/Course form. Returns the lean
 * department doc, or null when nothing was chosen. Inactive departments are
 * rejected for *new* links but tolerated when the record already pointed at
 * that department (so editing an unrelated field never fails).
 */
export async function resolveDepartmentForLink(departmentId, { currentDepartmentId = null } = {}) {
  if (departmentId === null || departmentId === undefined || departmentId === "") return null;
  const oid = asObjectId(departmentId);
  if (!oid) throw badRequest("Invalid academic department");
  const dept = await AcademicDepartment.findOne({ _id: oid, softDelete: false })
    .select("name code status")
    .lean();
  if (!dept) throw badRequest("Selected academic department was not found");
  const unchanged = currentDepartmentId && String(currentDepartmentId) === String(oid);
  if (dept.status !== "Active" && !unchanged) {
    throw badRequest(`Academic department "${dept.name}" is inactive — activate it before assigning`);
  }
  return dept;
}

/** A faculty who leaves a department (transfer or archive) can no longer be
 * its HOD. Clears the HOD pointer on every department except `keepDepartmentId`. */
export async function releaseHodRole(facultyOid, { keepDepartmentId = null, editor = "master-admin", reason = "" } = {}) {
  const query = { hod: facultyOid, softDelete: false };
  if (keepDepartmentId) query._id = { $ne: asObjectId(keepDepartmentId) };
  const affected = await AcademicDepartment.find(query).select("name").lean();
  if (!affected.length) return;
  await AcademicDepartment.updateMany(
    { _id: { $in: affected.map((d) => d._id) } },
    { $set: { hod: null, updatedBy: editor } }
  );
  for (const d of affected) {
    await logActivity("update", d, editor, `HOD removed from ${d.name}${reason ? ` — ${reason}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

async function assertUnique({ name, code }, excludeId = null) {
  const base = { softDelete: false };
  if (excludeId) base._id = { $ne: excludeId };
  const [byCode, byName] = await Promise.all([
    AcademicDepartment.findOne({ ...base, code }).select("name").lean(),
    AcademicDepartment.findOne({ ...base, normalizedName: normalizeDepartmentName(name) }).select("code").lean(),
  ]);
  if (byCode) throw conflict(`Department code "${code}" is already used by ${byCode.name}`);
  if (byName) throw conflict(`A department named "${name}" already exists (code ${byName.code})`);
}

async function assertValidHod(hodId, departmentId) {
  const oid = asObjectId(hodId);
  if (!oid) throw badRequest("Invalid HOD — select a faculty member");
  const faculty = await Faculty.findOne({ _id: oid, softDelete: false })
    .select("personalDetails.fullName status employmentDetails.departmentId")
    .lean();
  if (!faculty) throw badRequest("Selected HOD was not found in Faculty");
  if (faculty.status !== "Active") throw badRequest(`${faculty.personalDetails.fullName} is inactive and cannot be HOD`);
  if (!departmentId || String(faculty.employmentDetails?.departmentId || "") !== String(departmentId)) {
    throw badRequest(
      `${faculty.personalDetails.fullName} does not belong to this department. Link the faculty to this department first, then assign HOD.`
    );
  }
  return oid;
}

function translateDuplicateKeyError(err) {
  if (err?.code !== 11000) return err;
  const key = Object.keys(err.keyPattern || {})[0];
  if (key === "code") return conflict("This department code is already in use");
  if (key === "normalizedName") return conflict("A department with this name already exists");
  return conflict("A department with these details already exists");
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const SORTABLE = {
  name: "name",
  code: "code",
  status: "status",
  establishedYear: "establishedYear",
  capacity: "capacity",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
};

export async function listDepartments(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const isExport = Boolean(params.export);
  const limit = Math.min(isExport ? 5000 : 100, Math.max(1, Number(params.limit) || 10));
  const skip = (page - 1) * limit;

  const query = { softDelete: false };
  if (ACADEMIC_DEPARTMENT_STATUSES.includes(params.status)) query.status = params.status;

  const search = String(params.search || "").trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    const hodIds = await Faculty.find({ softDelete: false, "personalDetails.fullName": rx })
      .select("_id")
      .limit(500)
      .lean();
    query.$or = [{ name: rx }, { code: rx }, { shortName: rx }];
    if (hodIds.length) query.$or.push({ hod: { $in: hodIds.map((f) => f._id) } });
  }

  const sortField = SORTABLE[params.sortBy] || "name";
  const sortDir = String(params.sortOrder).toLowerCase() === "desc" ? -1 : 1;
  const sort = { [sortField]: sortDir, _id: 1 };

  const [total, docs] = await Promise.all([
    AcademicDepartment.countDocuments(query).maxTimeMS(8000),
    AcademicDepartment.find(query).sort(sort).skip(skip).limit(limit).lean().maxTimeMS(8000),
  ]);

  const [hods, counts] = await Promise.all([loadHods(docs), buildCounts(docs)]);
  const rows = docs.map((d) =>
    toRow(d, { hod: d.hod ? hods.get(String(d.hod)) || null : null, counts: counts.get(String(d._id)) })
  );

  return {
    rows,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

/** Lightweight list for dropdowns (Faculty/Course forms, filters). */
export async function listDepartmentOptions({ includeInactive = true } = {}) {
  const query = { softDelete: false };
  if (!includeInactive) query.status = "Active";
  const docs = await AcademicDepartment.find(query).select("name code shortName status").sort({ name: 1 }).lean();
  return docs.map((d) => ({ _id: String(d._id), name: d.name, code: d.code, shortName: d.shortName || "", status: d.status }));
}

export async function getDepartmentStats() {
  const [total, active, inactive, withHod, facultyLinked, facultyUnassigned, coursesLinked, coursesUnassigned, deptDocs] =
    await Promise.all([
      AcademicDepartment.countDocuments({ softDelete: false }),
      AcademicDepartment.countDocuments({ softDelete: false, status: "Active" }),
      AcademicDepartment.countDocuments({ softDelete: false, status: "Inactive" }),
      AcademicDepartment.countDocuments({ softDelete: false, hod: { $type: "objectId" } }),
      Faculty.countDocuments({ softDelete: false, "employmentDetails.departmentId": { $type: "objectId" } }),
      Faculty.countDocuments({ softDelete: false, "employmentDetails.departmentId": { $not: { $type: "objectId" } } }),
      Course.countDocuments({ softDelete: false, departmentId: { $type: "objectId" } }),
      Course.countDocuments({ softDelete: false, departmentId: { $not: { $type: "objectId" } } }),
      AcademicDepartment.find({ softDelete: false }).select("_id").lean(),
    ]);

  const index = await loadCourseIndex();
  const studentMap = await countStudentsByDepartment(index);
  const liveIds = new Set(deptDocs.map((d) => String(d._id)));
  let students = 0;
  for (const [deptId, n] of studentMap) if (liveIds.has(deptId)) students += n;

  return {
    total,
    active,
    inactive,
    withHod,
    faculty: facultyLinked,
    facultyUnassigned,
    courses: coursesLinked,
    coursesUnassigned,
    students,
  };
}

export async function getDepartmentById(id) {
  const doc = await findDepartmentDoc(id);
  const lean = doc.toObject();
  const [hods, counts] = await Promise.all([loadHods([lean]), buildCounts([lean])]);
  const deptCourseIds = await Course.find({ softDelete: false, departmentId: doc._id }).distinct("_id");
  const batches = deptCourseIds.length
    ? await Batch.countDocuments({ softDelete: false, courseId: { $in: deptCourseIds } })
    : 0;
  const row = toRow(lean, { hod: lean.hod ? hods.get(String(lean.hod)) || null : null, counts: counts.get(String(lean._id)) });
  row.counts.batches = batches;
  return row;
}

export async function listDepartmentFaculty(id, params = {}) {
  const doc = await findDepartmentDoc(id);
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(params.limit) || 10));
  const query = { softDelete: false, "employmentDetails.departmentId": doc._id };
  if (params.status === "Active" || params.status === "Inactive") query.status = params.status;
  const search = String(params.search || "").trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    query.$or = [{ facultyId: rx }, { "personalDetails.fullName": rx }, { "personalDetails.email": rx }];
  }
  const [total, docs] = await Promise.all([
    Faculty.countDocuments(query),
    Faculty.find(query)
      .select("facultyId personalDetails.fullName personalDetails.email personalDetails.mobile employmentDetails.designation employmentDetails.qualification status")
      .sort({ "personalDetails.fullName": 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);
  const hodId = doc.hod ? String(doc.hod) : "";
  return {
    rows: docs.map((f) => ({
      _id: String(f._id),
      facultyId: f.facultyId,
      fullName: f.personalDetails?.fullName || "",
      email: f.personalDetails?.email || "",
      mobile: f.personalDetails?.mobile || "",
      designation: f.employmentDetails?.designation || "",
      qualification: f.employmentDetails?.qualification || "",
      status: f.status,
      isHod: String(f._id) === hodId,
    })),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function listDepartmentCourses(id) {
  const doc = await findDepartmentDoc(id);
  const courses = await Course.find({ softDelete: false, departmentId: doc._id })
    .select("name code type category universityName universityShortName durationLabel durationMonths semesterCount semesters status")
    .sort({ name: 1 })
    .lean();
  const index = await loadCourseIndex();
  const deptId = String(doc._id);

  // Per-course enrolled counts in one aggregation
  const match = studentMatchForCourses(courses, index.deptByCourseName, deptId);
  const perCourse = new Map();
  if (match) {
    const groups = await Admission.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            cid: { $toString: "$details.courseId" },
            cname: { $toLower: { $trim: { input: { $ifNull: ["$course", ""] } } } },
          },
          n: { $sum: 1 },
        },
      },
    ]);
    const idByName = new Map(courses.map((c) => [String(c.name || "").trim().toLowerCase(), String(c._id)]));
    for (const g of groups) {
      const cid = g._id.cid || idByName.get(g._id.cname);
      if (cid) perCourse.set(cid, (perCourse.get(cid) || 0) + g.n);
    }
  }

  return courses.map((c) => ({
    _id: String(c._id),
    name: c.name,
    code: c.code || "",
    type: c.type,
    category: c.category,
    university: c.universityShortName || c.universityName || (c.type === "Institute" ? "Grow Skills Tech" : ""),
    duration: c.durationLabel || (c.durationMonths ? `${c.durationMonths} months` : ""),
    semesterCount: c.semesterCount || (Array.isArray(c.semesters) ? c.semesters.length : 0),
    subjectCount: (c.semesters || []).reduce((s, sem) => s + (sem.subjects?.length || 0), 0),
    status: c.status,
    students: perCourse.get(String(c._id)) || 0,
  }));
}

export async function listDepartmentStudents(id, params = {}) {
  const doc = await findDepartmentDoc(id);
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 10));
  const index = await loadCourseIndex();
  const deptId = String(doc._id);
  const courses = index.courses.filter((c) => String(c.departmentId || "") === deptId);
  const match = studentMatchForCourses(courses, index.deptByCourseName, deptId);
  if (!match) return { rows: [], pagination: { page, limit, total: 0, totalPages: 1 } };

  const and = [match];
  const search = String(params.search || "").trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    and.push({ $or: [{ applicant: rx }, { admissionId: rx }, { email: rx }, { phone: rx }] });
  }
  const filter = { $and: and };
  const [total, docs] = await Promise.all([
    Admission.countDocuments(filter).maxTimeMS(8000),
    Admission.find(filter)
      .select("admissionId applicant email phone course status admissionDate details.courseId details.batchId details.session details.currentSemester")
      .sort({ admissionDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .maxTimeMS(10000),
  ]);
  return {
    rows: docs.map((a) => ({
      _id: String(a._id),
      admissionId: a.admissionId,
      name: a.applicant,
      email: a.email,
      phone: a.phone,
      course: a.course || "",
      courseId: a.details?.courseId ? String(a.details.courseId) : "",
      session: a.details?.session || "",
      semester: a.details?.currentSemester ?? null,
      status: a.status,
      admissionDate: a.admissionDate,
    })),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createDepartment(payload, editor = "master-admin") {
  await assertUnique(payload);
  // A brand-new department has no faculty yet, so no one can qualify as HOD.
  if (payload.hod) {
    throw badRequest("Create the department first, link faculty to it, then assign the HOD");
  }
  let doc;
  try {
    doc = await AcademicDepartment.create({
      name: payload.name,
      code: payload.code,
      shortName: payload.shortName,
      description: payload.description,
      email: payload.email,
      phone: payload.phone,
      status: payload.status,
      establishedYear: payload.establishedYear,
      capacity: payload.capacity,
      normalizedName: normalizeDepartmentName(payload.name),
      createdBy: editor,
      updatedBy: editor,
    });
  } catch (err) {
    throw translateDuplicateKeyError(err);
  }
  await logActivity("create", doc, editor, `Created academic department ${doc.code} — ${doc.name}`, BASE_PATH);
  return getDepartmentById(doc._id);
}

export async function updateDepartment(id, payload, editor = "master-admin") {
  const doc = await findDepartmentDoc(id);
  await assertUnique(payload, doc._id);

  const previousName = doc.name;
  const previousHod = doc.hod ? String(doc.hod) : null;
  if (payload.hod !== undefined && String(payload.hod || "") !== String(previousHod || "")) {
    doc.hod = payload.hod ? await assertValidHod(payload.hod, doc._id) : null;
  }

  doc.name = payload.name;
  doc.normalizedName = normalizeDepartmentName(payload.name);
  doc.code = payload.code;
  doc.shortName = payload.shortName;
  doc.description = payload.description;
  doc.email = payload.email;
  doc.phone = payload.phone;
  doc.status = payload.status;
  doc.establishedYear = payload.establishedYear;
  doc.capacity = payload.capacity;
  doc.updatedBy = editor;
  try {
    await doc.save();
  } catch (err) {
    throw translateDuplicateKeyError(err);
  }

  // Faculty keep a denormalized department name for list/search/export —
  // keep it in sync on rename.
  if (previousName !== doc.name) {
    await Faculty.updateMany(
      { "employmentDetails.departmentId": doc._id },
      { $set: { "employmentDetails.department": doc.name } }
    );
  }

  await logActivity("update", doc, editor, `Updated academic department ${doc.code} — ${doc.name}`);
  return getDepartmentById(doc._id);
}

export async function setDepartmentStatus(id, status, editor = "master-admin") {
  if (!ACADEMIC_DEPARTMENT_STATUSES.includes(status)) throw badRequest("Status must be Active or Inactive");
  const doc = await findDepartmentDoc(id);
  doc.status = status;
  doc.updatedBy = editor;
  await doc.save();
  await logActivity("update", doc, editor, `Academic department ${doc.code} marked ${status}`, `${BASE_PATH}/${doc._id}/status`);
  return getDepartmentById(doc._id);
}

export async function setDepartmentHod(id, hodId, editor = "master-admin") {
  const doc = await findDepartmentDoc(id);
  const previous = doc.hod ? String(doc.hod) : "";
  doc.hod = hodId ? await assertValidHod(hodId, doc._id) : null;
  doc.updatedBy = editor;
  await doc.save();

  const entry = await getDepartmentById(doc._id);
  const message = !hodId
    ? `HOD removed from ${doc.name}`
    : previous
      ? `HOD of ${doc.name} changed to ${entry.hod?.name || hodId}`
      : `${entry.hod?.name || hodId} assigned as HOD of ${doc.name}`;
  await logActivity("update", doc, editor, message, `${BASE_PATH}/${doc._id}/hod`);
  return entry;
}

/** Soft-deletes (archives) a department — only when nothing depends on it.
 * Departments with faculty/courses/students must be deactivated instead. */
export async function deleteDepartment(id, editor = "master-admin") {
  const doc = await findDepartmentDoc(id);
  const counts = (await buildCounts([doc.toObject()])).get(String(doc._id));
  const blockers = [];
  if (counts.faculty) blockers.push(plural(counts.faculty, "faculty member"));
  if (counts.courses) blockers.push(plural(counts.courses, "course"));
  if (counts.students) blockers.push(plural(counts.students, "enrolled student"));
  if (blockers.length) {
    throw conflict(
      `This department cannot be deleted because it has ${blockers.join(", ")}. Please deactivate it instead.`
    );
  }

  doc.softDelete = true;
  doc.status = "Inactive";
  doc.hod = null;
  doc.updatedBy = editor;
  await doc.save();
  await logActivity("delete", doc, editor, `Deleted academic department ${doc.code} — ${doc.name}`);
  return { _id: String(doc._id), name: doc.name, code: doc.code };
}
