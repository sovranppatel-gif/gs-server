import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { Faculty, FACULTY_STATUSES } from "./faculty.model.js";
import { FacultyAssignment } from "./facultyAssignment.model.js";
import { FacultyTimetable } from "./facultyTimetable.model.js";
import { FacultyAttendance } from "./facultyAttendance.model.js";
import { University } from "../universities/universities.model.js";
import { Course } from "../courses/courses.model.js";
import { Batch } from "../batches/batches.model.js";
import { Admission } from "../../models/Admission.js";
import { reserveNextSequence } from "../../lib/sequence.js";
import { createActivityLog } from "../activityLog/activityLog.service.js";
import { emitSectionUpdate } from "../../lib/socket.js";

export const FACULTY_DESIGNATIONS = [
  "Trainer",
  "Senior Trainer",
  "Assistant Professor",
  "Associate Professor",
  "Professor",
  "Head of Department",
  "Visiting Faculty",
  "Lab Instructor",
];

export const FACULTY_DEPARTMENTS = [
  "Computer Science",
  "Information Technology",
  "Electronics",
  "Mechanical",
  "Management",
  "Design",
  "General",
];

export const FACULTY_PERMISSIONS = [
  "faculty.attendance.mark",
  "faculty.assignments.manage",
  "faculty.timetable.manage",
  "faculty.students.view",
  "faculty.marks.enter",
  "faculty.study-materials.upload",
  "faculty.announcements.post",
];

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const raw = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * dateOfBirth/joiningDate are pure calendar dates with no meaningful
 * time-of-day, so the label is built from the same UTC Y/M/D components as
 * dateInputValue() (which feeds the <input type="date"> pickers) — never
 * reinterpreted through a timezone, or the two can disagree on which day it
 * is near midnight.
 */
function formatDateLabel(value) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = MONTH_LABELS[d.getUTCMonth()];
  return `${day} ${month} ${d.getUTCFullYear()}`;
}

function dateInputValue(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

async function nextFacultyId() {
  const seq = await reserveNextSequence({
    key: "faculty",
    readMax: async () => {
      const [result] = await Faculty.aggregate([
        { $match: { facultyId: { $regex: "^FAC-[0-9]+$" } } },
        {
          $project: {
            seq: {
              $convert: { input: { $substrCP: ["$facultyId", 4, 20] }, to: "int", onError: 0, onNull: 0 },
            },
          },
        },
        { $group: { _id: null, maxSeq: { $max: "$seq" } } },
      ]);
      return result?.maxSeq || 0;
    },
  });
  return `FAC-${String(seq).padStart(4, "0")}`;
}

/** List-view row: lightweight, no nested sub-resource data. */
function toRow(doc) {
  const d = doc?.toObject ? doc.toObject() : doc;
  const personal = d.personalDetails || {};
  const employment = d.employmentDetails || {};
  const account = d.accountDetails || {};
  return {
    _id: String(d._id),
    facultyId: d.facultyId,
    fullName: personal.fullName || "",
    profilePhoto: personal.profilePhoto || "",
    mobile: personal.mobile || "",
    email: personal.email || "",
    designation: employment.designation || "",
    department: employment.department || "",
    assignedCourses: Array.isArray(d.assignedCourses) ? d.assignedCourses : [],
    joiningDate: dateInputValue(employment.joiningDate),
    joiningDateLabel: formatDateLabel(employment.joiningDate),
    loginEnabled: Boolean(account.loginEnabled),
    status: d.status,
    createdAt: d.createdAt,
  };
}

/** Full entry: nested groups (matches facultyFormUtils.facultyToForm) + flattened
 * convenience fields the list/table columns read directly. Never includes
 * accountDetails.passwordHash. */
function toEntry(doc, stats = null) {
  const d = doc?.toObject ? doc.toObject() : doc;
  const personal = d.personalDetails || {};
  const employment = d.employmentDetails || {};
  const account = d.accountDetails || {};
  return {
    _id: String(d._id),
    facultyId: d.facultyId,
    status: d.status,
    permissions: Array.isArray(d.permissions) ? d.permissions : [],
    // Flattened convenience copies (list columns / older call sites read these)
    fullName: personal.fullName || "",
    mobile: personal.mobile || "",
    email: personal.email || "",
    designation: employment.designation || "",
    department: employment.department || "",
    profilePhoto: personal.profilePhoto || "",
    joiningDate: dateInputValue(employment.joiningDate),
    joiningDateLabel: formatDateLabel(employment.joiningDate),
    assignedCourses: Array.isArray(d.assignedCourses) ? d.assignedCourses : [],
    personalDetails: {
      fullName: personal.fullName || "",
      profilePhoto: personal.profilePhoto || "",
      gender: personal.gender || "Male",
      dateOfBirth: dateInputValue(personal.dateOfBirth),
      dateOfBirthLabel: formatDateLabel(personal.dateOfBirth),
      fatherOrHusbandName: personal.fatherOrHusbandName || "",
      mobile: personal.mobile || "",
      alternateMobile: personal.alternateMobile || "",
      email: personal.email || "",
      address: personal.address || "",
      city: personal.city || "",
      state: personal.state || "",
      pincode: personal.pincode || "",
    },
    employmentDetails: {
      designation: employment.designation || "",
      department: employment.department || "",
      qualification: employment.qualification || "",
      specialization: employment.specialization || "",
      experienceYears: employment.experienceYears ?? 0,
      joiningDate: dateInputValue(employment.joiningDate),
      joiningDateLabel: formatDateLabel(employment.joiningDate),
      employmentType: employment.employmentType || "Full Time",
    },
    accountDetails: {
      loginEnabled: Boolean(account.loginEnabled),
      username: account.username || "",
    },
    stats: stats || { assignedCourses: 0, assignedSubjects: 0, assignedBatches: 0, totalStudents: 0 },
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function toAssignmentRow(doc) {
  const d = doc?.toObject ? doc.toObject() : doc;
  return {
    _id: String(d._id),
    // facultyId (the human-readable code) is filled in by the caller, which
    // knows whether it already has the Faculty doc or needs to populate it.
    universityId: d.universityId ? String(d.universityId) : "",
    universityName: d.universityName || "",
    courseId: d.courseId ? String(d.courseId) : "",
    courseName: d.courseName || "",
    semester: d.semester ?? null,
    subjectName: d.subjectName || "",
    subjectCode: d.subjectCode || "",
    batchId: d.batchId ? String(d.batchId) : "",
    batchName: d.batchName || "",
    academicYear: d.academicYear || "",
    status: d.status,
  };
}

function toTimetableRow(doc) {
  const d = doc?.toObject ? doc.toObject() : doc;
  return {
    _id: String(d._id),
    facultyMongoId: String(d.facultyId),
    facultyName: d.facultyName || "",
    universityId: d.universityId ? String(d.universityId) : "",
    courseId: d.courseId ? String(d.courseId) : "",
    courseName: d.courseName || "",
    batchId: String(d.batchId),
    batchName: d.batchName || "",
    semester: d.semester ?? null,
    subjectName: d.subjectName || "",
    subjectCode: d.subjectCode || "",
    day: d.day,
    startTime: d.startTime,
    endTime: d.endTime,
    room: d.room || "",
    status: d.status,
  };
}

async function findFacultyDoc(id, { includePasswordHash = false } = {}) {
  const oid = asObjectId(id);
  let query = null;
  if (oid) query = Faculty.findOne({ _id: oid, softDelete: false });
  else query = Faculty.findOne({ facultyId: String(id || "").trim(), softDelete: false });
  if (includePasswordHash) query = query.select("+accountDetails.passwordHash");
  return query;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

// ---------------------------------------------------------------------------
// Faculty CRUD
// ---------------------------------------------------------------------------

export async function listFaculties(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  // The interactive list view is capped at 200/page so a crafted request can't
  // pull the whole table into the browser. CSV export legitimately asks for
  // everything in one page (?export=1&limit=2000) — allow a much higher
  // ceiling only for that flag, never for the normal paginated view.
  const isExport = Boolean(params.export);
  const maxLimit = isExport ? 5000 : 200;
  const limit = Math.min(maxLimit, Math.max(1, Number(params.limit) || 10));
  const skip = (page - 1) * limit;

  const query = { softDelete: false };
  const and = [];

  if (params.status) and.push({ status: params.status });
  if (params.designation) and.push({ "employmentDetails.designation": params.designation });
  if (params.department) and.push({ "employmentDetails.department": params.department });

  const search = String(params.search || "").trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    and.push({
      $or: [
        { facultyId: rx },
        { "personalDetails.fullName": rx },
        { "personalDetails.mobile": rx },
        { "personalDetails.email": rx },
        { "accountDetails.username": rx },
      ],
    });
  }

  // University/course filters: faculty has no direct university/course field,
  // so scope by active assignments — one indexed lookup, not per-row.
  if (params.universityId || params.courseId) {
    const assignQuery = { status: "Active" };
    const uniOid = asObjectId(params.universityId);
    const courseOid = asObjectId(params.courseId);
    if (uniOid) assignQuery.universityId = uniOid;
    if (courseOid) assignQuery.courseId = courseOid;
    const ids = await FacultyAssignment.distinct("facultyId", assignQuery);
    and.push({ _id: { $in: ids.length ? ids : [null] } });
  }

  if (and.length) query.$and = and;

  const [total, docs] = await Promise.all([
    Faculty.countDocuments(query).maxTimeMS(8000),
    Faculty.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .maxTimeMS(12000),
  ]);

  const rows = docs.map(toRow);
  const stats = await getFacultyStatsOverview();

  return {
    rows,
    stats,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function getFacultyStatsOverview() {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [total, active, inactive, newThisMonth, assignedIds] = await Promise.all([
    Faculty.countDocuments({ softDelete: false }).maxTimeMS(8000),
    Faculty.countDocuments({ softDelete: false, status: "Active" }).maxTimeMS(8000),
    Faculty.countDocuments({ softDelete: false, status: "Inactive" }).maxTimeMS(8000),
    Faculty.countDocuments({ softDelete: false, createdAt: { $gte: startOfMonth } }).maxTimeMS(8000),
    FacultyAssignment.distinct("facultyId", { status: "Active" }),
  ]);

  return { total, active, inactive, newThisMonth, assigned: assignedIds.length };
}

export async function getFacultyMeta() {
  const [designations, departments] = await Promise.all([
    Faculty.distinct("employmentDetails.designation", { softDelete: false }),
    Faculty.distinct("employmentDetails.department", { softDelete: false }),
  ]);

  const designationSet = new Set([...FACULTY_DESIGNATIONS, ...designations.filter(Boolean)]);
  const departmentSet = new Set([...FACULTY_DEPARTMENTS, ...departments.filter(Boolean)]);

  return {
    designations: [...designationSet].sort(),
    departments: [...departmentSet].sort(),
    permissions: FACULTY_PERMISSIONS,
  };
}

async function computeFacultyStats(facultyOid) {
  const [courseIds, subjectCount, batchIds, batchAgg] = await Promise.all([
    FacultyAssignment.distinct("courseId", { facultyId: facultyOid, status: "Active" }),
    FacultyAssignment.countDocuments({ facultyId: facultyOid, status: "Active" }),
    FacultyAssignment.distinct("batchId", { facultyId: facultyOid, status: "Active", batchId: { $ne: null } }),
    FacultyAssignment.aggregate([
      { $match: { facultyId: facultyOid, status: "Active", batchId: { $ne: null } } },
      { $group: { _id: "$batchId" } },
      {
        $lookup: { from: "batches", localField: "_id", foreignField: "_id", as: "batch" },
      },
      { $unwind: { path: "$batch", preserveNullAndEmptyArrays: true } },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$batch.enrolledCount", 0] } } } },
    ]),
  ]);

  return {
    assignedCourses: courseIds.length,
    assignedSubjects: subjectCount,
    assignedBatches: batchIds.length,
    totalStudents: batchAgg[0]?.total || 0,
  };
}

export async function getFacultyById(id) {
  const doc = await findFacultyDoc(id);
  if (!doc) return null;
  const stats = await computeFacultyStats(doc._id);
  return toEntry(doc, stats);
}

async function assertNoDuplicates({ email, mobile, username, excludeId = null }) {
  const or = [];
  if (email) or.push({ "personalDetails.email": email });
  if (mobile) or.push({ "personalDetails.mobile": mobile });
  if (username) or.push({ "accountDetails.username": username });
  if (!or.length) return;

  const query = { softDelete: false, $or: or };
  if (excludeId) query._id = { $ne: excludeId };

  const existing = await Faculty.findOne(query)
    .select("personalDetails.email personalDetails.mobile accountDetails.username")
    .lean();
  if (!existing) return;

  if (email && existing.personalDetails?.email === email) throw conflict("A faculty with this email already exists");
  if (mobile && existing.personalDetails?.mobile === mobile) throw conflict("A faculty with this mobile number already exists");
  if (username && existing.accountDetails?.username === username) throw conflict("This username is already taken");
}

export async function createFaculty(payload, editor = "master-admin") {
  await assertNoDuplicates({
    email: payload.personalDetails.email,
    mobile: payload.personalDetails.mobile,
    username: payload.accountDetails.loginEnabled ? payload.accountDetails.username : "",
  });

  const passwordHash = payload.password ? await bcrypt.hash(payload.password, 10) : "";

  const doc = await Faculty.create({
    facultyId: await nextFacultyId(),
    personalDetails: payload.personalDetails,
    employmentDetails: payload.employmentDetails,
    accountDetails: {
      loginEnabled: payload.accountDetails.loginEnabled,
      username: payload.accountDetails.loginEnabled ? payload.accountDetails.username : "",
      passwordHash,
    },
    status: payload.status,
    permissions: payload.permissions,
    createdBy: editor,
    updatedBy: editor,
  });

  await createActivityLog({
    section: "Faculty",
    action: "create",
    actor: editor,
    resourceId: doc.facultyId,
    message: `Created faculty ${doc.facultyId} — ${doc.personalDetails.fullName}`,
    path: "/api/faculties",
  });
  emitSectionUpdate({
    section: "Faculty",
    action: "create",
    resourceId: doc.facultyId,
    message: `Faculty ${doc.facultyId} created`,
    at: new Date().toISOString(),
  });

  return getFacultyById(doc._id);
}

export async function updateFaculty(id, payload, editor = "master-admin") {
  const doc = await findFacultyDoc(id, { includePasswordHash: true });
  if (!doc) throw notFound("Faculty not found");

  await assertNoDuplicates({
    email: payload.personalDetails.email,
    mobile: payload.personalDetails.mobile,
    username: payload.accountDetails.loginEnabled ? payload.accountDetails.username : "",
    excludeId: doc._id,
  });

  doc.personalDetails = payload.personalDetails;
  doc.employmentDetails = payload.employmentDetails;
  doc.accountDetails.loginEnabled = payload.accountDetails.loginEnabled;
  doc.accountDetails.username = payload.accountDetails.loginEnabled ? payload.accountDetails.username : "";
  // Only rehash when a new password was actually submitted — never touch the
  // stored hash otherwise.
  if (payload.password) {
    doc.accountDetails.passwordHash = await bcrypt.hash(payload.password, 10);
  }
  doc.status = payload.status;
  doc.permissions = payload.permissions;
  doc.updatedBy = editor;
  await doc.save();

  await createActivityLog({
    section: "Faculty",
    action: "update",
    actor: editor,
    resourceId: doc.facultyId,
    message: `Updated faculty ${doc.facultyId}`,
    path: `/api/faculties/${doc.facultyId}`,
  });
  emitSectionUpdate({
    section: "Faculty",
    action: "update",
    resourceId: doc.facultyId,
    message: `Faculty ${doc.facultyId} updated`,
    at: new Date().toISOString(),
  });

  return getFacultyById(doc._id);
}

export async function updateFacultyStatus(id, status, editor = "master-admin") {
  if (!FACULTY_STATUSES.includes(status)) throw badRequest("Invalid status");
  const doc = await findFacultyDoc(id);
  if (!doc) throw notFound("Faculty not found");

  doc.status = status;
  doc.updatedBy = editor;
  await doc.save();

  await createActivityLog({
    section: "Faculty",
    action: "update",
    actor: editor,
    resourceId: doc.facultyId,
    message: `Faculty ${doc.facultyId} marked ${status}`,
    path: `/api/faculties/${doc.facultyId}/status`,
  });

  return getFacultyById(doc._id);
}

export async function deleteFaculty(id, editor = "master-admin") {
  const doc = await findFacultyDoc(id);
  if (!doc) throw notFound("Faculty not found");

  doc.softDelete = true;
  doc.status = "Inactive";
  doc.accountDetails.loginEnabled = false;
  doc.updatedBy = editor;
  await doc.save();

  await createActivityLog({
    section: "Faculty",
    action: "delete",
    actor: editor,
    resourceId: doc.facultyId,
    message: `Archived faculty ${doc.facultyId}`,
    path: `/api/faculties/${doc.facultyId}`,
  });

  // Build the response from the doc we just mutated rather than re-fetching
  // by id — findFacultyDoc()/getFacultyById() filter on softDelete: false,
  // so a lookup here would always come back empty right after archiving.
  const stats = await computeFacultyStats(doc._id);
  return toEntry(doc, stats);
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

async function refreshAssignedCourses(facultyOid) {
  const courseNames = await FacultyAssignment.distinct("courseName", {
    facultyId: facultyOid,
    status: "Active",
    courseName: { $ne: "" },
  });
  await Faculty.updateOne({ _id: facultyOid }, { $set: { assignedCourses: courseNames.sort() } });
}

async function hydrateAssignmentRefs(payload) {
  const universityOid = asObjectId(payload.universityId);
  const courseOid = asObjectId(payload.courseId);
  const batchOid = asObjectId(payload.batchId);

  if (!courseOid) throw badRequest("Course is required");
  const course = await Course.findOne({ _id: courseOid, softDelete: false }).lean();
  if (!course) throw badRequest("Course not found");

  let universityName = "";
  if (universityOid) {
    const uni = await University.findOne({ _id: universityOid, softDelete: false }).select("name").lean();
    universityName = uni?.name || "";
  }

  let batchName = "";
  if (batchOid) {
    const batch = await Batch.findOne({ _id: batchOid, softDelete: false }).select("name").lean();
    if (!batch) throw badRequest("Batch not found");
    batchName = batch.name || "";
  }

  return {
    universityId: universityOid,
    universityName,
    courseId: courseOid,
    courseName: course.name || "",
    batchId: batchOid,
    batchName,
  };
}

function assignmentRowsWithFacultyId(docs, facultyMongoId) {
  return docs.map((d) => {
    const row = toAssignmentRow(d);
    row.facultyId = facultyMongoId ? String(facultyMongoId) : String(d.facultyId);
    return row;
  });
}

export async function getFacultyAssignments(facultyId) {
  const faculty = await findFacultyDoc(facultyId);
  if (!faculty) throw notFound("Faculty not found");
  const docs = await FacultyAssignment.find({ facultyId: faculty._id })
    .sort({ createdAt: -1 })
    .lean()
    .maxTimeMS(8000);
  return { rows: assignmentRowsWithFacultyId(docs, faculty._id), facultyId: String(faculty._id) };
}

export async function getAllFacultyAssignments(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(params.limit) || 10));
  const skip = (page - 1) * limit;

  const query = {};
  if (params.status) query.status = params.status;

  const search = String(params.search || "").trim();
  let facultyIdFilter = null;
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    const matchingFaculty = await Faculty.find({
      softDelete: false,
      $or: [{ facultyId: rx }, { "personalDetails.fullName": rx }],
    })
      .select("_id")
      .lean();
    facultyIdFilter = matchingFaculty.map((f) => f._id);
    query.$or = [
      { courseName: rx },
      { subjectName: rx },
      { batchName: rx },
      ...(facultyIdFilter.length ? [{ facultyId: { $in: facultyIdFilter } }] : []),
    ];
  }

  const [total, docs] = await Promise.all([
    FacultyAssignment.countDocuments(query).maxTimeMS(8000),
    FacultyAssignment.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({ path: "facultyId", select: "facultyId personalDetails.fullName" })
      .lean()
      .maxTimeMS(12000),
  ]);

  const rows = docs.map((d) => {
    const row = toAssignmentRow(d);
    row.facultyMongoId = String(d.facultyId?._id || d.facultyId);
    row.facultyId = d.facultyId?.facultyId || "";
    row.facultyName = d.facultyId?.personalDetails?.fullName || "";
    return row;
  });

  return { rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

export async function createFacultyAssignment(facultyId, payload, editor = "master-admin") {
  const faculty = await findFacultyDoc(facultyId);
  if (!faculty) throw notFound("Faculty not found");

  const subjectName = String(payload.subjectName || "").trim();
  if (!subjectName) throw badRequest("Subject is required");

  const refs = await hydrateAssignmentRefs(payload);

  const duplicate = await FacultyAssignment.findOne({
    facultyId: faculty._id,
    subjectName,
    batchId: refs.batchId,
    status: "Active",
  }).lean();
  if (duplicate) throw conflict("This faculty is already assigned to this subject and batch");

  const doc = await FacultyAssignment.create({
    facultyId: faculty._id,
    ...refs,
    semester: payload.semester ? Number(payload.semester) : null,
    subjectName,
    subjectCode: String(payload.subjectCode || "").trim(),
    academicYear: String(payload.academicYear || "").trim(),
    status: "Active",
    createdBy: editor,
    updatedBy: editor,
  });

  await refreshAssignedCourses(faculty._id);
  await createActivityLog({
    section: "Faculty Assignments",
    action: "create",
    actor: editor,
    resourceId: faculty.facultyId,
    message: `Assigned ${faculty.facultyId} to ${refs.courseName} — ${subjectName}`,
    path: `/api/faculties/${faculty.facultyId}/assignments`,
  });

  return assignmentRowsWithFacultyId([doc], faculty._id)[0];
}

export async function updateFacultyAssignment(assignmentId, payload, editor = "master-admin") {
  const oid = asObjectId(assignmentId);
  if (!oid) throw badRequest("Invalid assignment id");
  const doc = await FacultyAssignment.findById(oid);
  if (!doc) throw notFound("Assignment not found");

  const subjectName = String(payload.subjectName || doc.subjectName || "").trim();
  if (!subjectName) throw badRequest("Subject is required");

  const refs = await hydrateAssignmentRefs({
    universityId: payload.universityId ?? doc.universityId,
    courseId: payload.courseId ?? doc.courseId,
    batchId: payload.batchId ?? doc.batchId,
  });

  Object.assign(doc, refs, {
    semester: payload.semester ? Number(payload.semester) : doc.semester,
    subjectName,
    subjectCode: String(payload.subjectCode ?? doc.subjectCode ?? "").trim(),
    academicYear: String(payload.academicYear ?? doc.academicYear ?? "").trim(),
    updatedBy: editor,
  });
  await doc.save();
  await refreshAssignedCourses(doc.facultyId);

  return assignmentRowsWithFacultyId([doc], doc.facultyId)[0];
}

export async function updateFacultyAssignmentStatus(assignmentId, status, editor = "master-admin") {
  const oid = asObjectId(assignmentId);
  if (!oid) throw badRequest("Invalid assignment id");
  const doc = await FacultyAssignment.findById(oid);
  if (!doc) throw notFound("Assignment not found");

  doc.status = status === "Inactive" ? "Inactive" : "Active";
  doc.updatedBy = editor;
  await doc.save();
  await refreshAssignedCourses(doc.facultyId);

  return assignmentRowsWithFacultyId([doc], doc.facultyId)[0];
}

export async function deleteFacultyAssignment(assignmentId, editor = "master-admin") {
  const oid = asObjectId(assignmentId);
  if (!oid) throw badRequest("Invalid assignment id");
  const doc = await FacultyAssignment.findByIdAndDelete(oid);
  if (!doc) throw notFound("Assignment not found");

  await refreshAssignedCourses(doc.facultyId);
  await createActivityLog({
    section: "Faculty Assignments",
    action: "delete",
    actor: editor,
    resourceId: String(doc.facultyId),
    message: `Removed assignment ${doc.subjectName}`,
    path: `/api/faculties/assignments/${assignmentId}`,
  });

  return assignmentRowsWithFacultyId([doc], doc.facultyId)[0];
}

// ---------------------------------------------------------------------------
// Timetable
// ---------------------------------------------------------------------------

function timesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

async function assertNoTimetableConflict({ facultyId, day, startTime, endTime, excludeId = null }) {
  if (!(startTime < endTime)) throw badRequest("Start time must be before end time");

  const query = { facultyId, day, status: "Active" };
  if (excludeId) query._id = { $ne: excludeId };

  const sameDay = await FacultyTimetable.find(query).select("startTime endTime").lean();
  const conflict1 = sameDay.some((slot) => timesOverlap(startTime, endTime, slot.startTime, slot.endTime));
  if (conflict1) {
    throw conflict(`This faculty already has a class on ${day} that overlaps ${startTime}–${endTime}`);
  }
}

export async function getFacultyTimetable(facultyId) {
  const faculty = await findFacultyDoc(facultyId);
  if (!faculty) throw notFound("Faculty not found");
  const docs = await FacultyTimetable.find({ facultyId: faculty._id, status: "Active" })
    .sort({ day: 1, startTime: 1 })
    .lean()
    .maxTimeMS(8000);
  return { rows: docs.map(toTimetableRow), facultyId: String(faculty._id) };
}

export async function getInstituteTimetable(params = {}) {
  const query = { status: "Active" };
  if (params.day) query.day = params.day;
  const facultyOid = asObjectId(params.facultyId);
  if (facultyOid) query.facultyId = facultyOid;

  const docs = await FacultyTimetable.find(query)
    .sort({ day: 1, startTime: 1 })
    .lean()
    .maxTimeMS(8000);
  return { rows: docs.map(toTimetableRow) };
}

export async function createFacultyTimetable(facultyId, payload, editor = "master-admin") {
  const faculty = await findFacultyDoc(facultyId);
  if (!faculty) throw notFound("Faculty not found");

  const batchOid = asObjectId(payload.batchId);
  if (!batchOid) throw badRequest("Batch is required");
  const batch = await Batch.findOne({ _id: batchOid, softDelete: false }).lean();
  if (!batch) throw badRequest("Batch not found");

  const subjectName = String(payload.subjectName || "").trim();
  if (!subjectName) throw badRequest("Subject is required");

  const day = String(payload.day || "").trim();
  const startTime = String(payload.startTime || "").trim();
  const endTime = String(payload.endTime || "").trim();

  await assertNoTimetableConflict({ facultyId: faculty._id, day, startTime, endTime });

  const courseOid = asObjectId(payload.courseId);
  const universityOid = asObjectId(payload.universityId);

  const doc = await FacultyTimetable.create({
    facultyId: faculty._id,
    facultyName: faculty.personalDetails?.fullName || "",
    universityId: universityOid,
    courseId: courseOid,
    courseName: String(payload.courseName || "").trim(),
    batchId: batch._id,
    batchName: batch.name || "",
    semester: payload.semester ? Number(payload.semester) : null,
    subjectName,
    subjectCode: String(payload.subjectCode || "").trim(),
    day,
    startTime,
    endTime,
    room: String(payload.room || "").trim(),
    status: "Active",
    createdBy: editor,
    updatedBy: editor,
  });

  await createActivityLog({
    section: "Faculty Timetable",
    action: "create",
    actor: editor,
    resourceId: faculty.facultyId,
    message: `Added ${day} ${startTime}-${endTime} class for ${faculty.facultyId}`,
    path: `/api/faculties/${faculty.facultyId}/timetable`,
  });

  return toTimetableRow(doc);
}

export async function updateFacultyTimetable(entryId, payload, editor = "master-admin") {
  const oid = asObjectId(entryId);
  if (!oid) throw badRequest("Invalid timetable id");
  const doc = await FacultyTimetable.findById(oid);
  if (!doc) throw notFound("Timetable entry not found");

  const day = String(payload.day || doc.day);
  const startTime = String(payload.startTime || doc.startTime);
  const endTime = String(payload.endTime || doc.endTime);
  await assertNoTimetableConflict({ facultyId: doc.facultyId, day, startTime, endTime, excludeId: doc._id });

  if (payload.batchId) {
    const batch = await Batch.findOne({ _id: asObjectId(payload.batchId), softDelete: false }).lean();
    if (!batch) throw badRequest("Batch not found");
    doc.batchId = batch._id;
    doc.batchName = batch.name || "";
  }

  doc.day = day;
  doc.startTime = startTime;
  doc.endTime = endTime;
  if (payload.subjectName !== undefined) doc.subjectName = String(payload.subjectName).trim();
  if (payload.subjectCode !== undefined) doc.subjectCode = String(payload.subjectCode).trim();
  if (payload.room !== undefined) doc.room = String(payload.room).trim();
  if (payload.semester !== undefined) doc.semester = payload.semester ? Number(payload.semester) : null;
  doc.updatedBy = editor;
  await doc.save();

  return toTimetableRow(doc);
}

export async function deleteFacultyTimetable(entryId, editor = "master-admin") {
  const oid = asObjectId(entryId);
  if (!oid) throw badRequest("Invalid timetable id");
  const doc = await FacultyTimetable.findByIdAndDelete(oid);
  if (!doc) throw notFound("Timetable entry not found");

  await createActivityLog({
    section: "Faculty Timetable",
    action: "delete",
    actor: editor,
    resourceId: String(doc.facultyId),
    message: `Removed ${doc.day} ${doc.startTime}-${doc.endTime} class`,
    path: `/api/faculties/timetable/${entryId}`,
  });

  return toTimetableRow(doc);
}

// ---------------------------------------------------------------------------
// Attendance (faculty's own check-in/out — see facultyAttendance.model.js)
// ---------------------------------------------------------------------------

/** Today's calendar date in IST, expressed as a UTC-midnight Date. */
function todayIst() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

/**
 * Normalizes to midnight UTC of the given value's own UTC calendar date
 * (falling back to today in IST when no value is given). Deliberately uses
 * UTC getters/Date.UTC rather than `setHours(0,0,0,0)` — that mutates in the
 * *host process's local* timezone, which silently rolls a date like
 * "2026-09-07" back to 2026-09-06T18:30Z whenever the host runs in IST
 * (UTC+5:30), so every read-back via toISOString() reports the wrong day.
 */
function dayStart(value) {
  if (!value) return todayIst();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return todayIst();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function getFacultyAttendance(facultyId) {
  const faculty = await findFacultyDoc(facultyId);
  if (!faculty) throw notFound("Faculty not found");

  const today = dayStart();
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

  const [rows, todayDoc] = await Promise.all([
    FacultyAttendance.find({ facultyId: faculty._id, date: { $gte: monthStart } })
      .sort({ date: -1 })
      .lean()
      .maxTimeMS(8000),
    FacultyAttendance.findOne({ facultyId: faculty._id, date: today }).lean(),
  ]);

  const present = rows.filter((r) => r.status === "Present").length;
  const late = rows.filter((r) => r.status === "Late").length;
  const leave = rows.filter((r) => r.status === "Leave").length;
  const percent = rows.length ? Math.round(((present + late) / rows.length) * 100) : 0;

  return {
    today: todayDoc
      ? { status: todayDoc.status, checkInTime: todayDoc.checkInTime, checkOutTime: todayDoc.checkOutTime }
      : null,
    rows: rows.map((r) => ({
      _id: String(r._id),
      date: dateInputValue(r.date),
      dateLabel: formatDateLabel(r.date),
      status: r.status,
      checkInTime: r.checkInTime,
      checkOutTime: r.checkOutTime,
      method: r.method,
      note: r.note,
    })),
    stats: { present, late, leave, percent },
    month: monthStart.toISOString().slice(0, 7),
  };
}

export async function saveFacultyAttendance(facultyId, payload, editor = "master-admin") {
  const faculty = await findFacultyDoc(facultyId);
  if (!faculty) throw notFound("Faculty not found");

  const date = dayStart(payload.date);
  const entry = await FacultyAttendance.findOneAndUpdate(
    { facultyId: faculty._id, date },
    {
      $set: {
        status: payload.status || "Present",
        checkInTime: payload.checkInTime || "",
        checkOutTime: payload.checkOutTime || "",
        method: payload.method || "Manual",
        note: payload.note || "",
        markedBy: editor,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return {
    _id: String(entry._id),
    date: dateInputValue(entry.date),
    status: entry.status,
    checkInTime: entry.checkInTime,
    checkOutTime: entry.checkOutTime,
  };
}

// ---------------------------------------------------------------------------
// Students & Exams (resolved via assignments → batch, not duplicated storage)
// ---------------------------------------------------------------------------

export async function getFacultyStudents(facultyId) {
  const faculty = await findFacultyDoc(facultyId);
  if (!faculty) throw notFound("Faculty not found");

  const batchIds = await FacultyAssignment.distinct("batchId", {
    facultyId: faculty._id,
    status: "Active",
    batchId: { $ne: null },
  });
  if (!batchIds.length) return { rows: [], total: 0 };

  const batches = await Batch.find({ _id: { $in: batchIds } })
    .select("batchId name courseName")
    .lean();
  const batchKeys = new Set();
  const batchById = new Map();
  for (const b of batches) {
    batchKeys.add(String(b.batchId));
    batchKeys.add(String(b._id));
    batchById.set(String(b._id), b);
  }

  const admissions = await Admission.find({
    status: "Approved",
    $or: [
      { "details.batchId": { $in: [...batchKeys] } },
      { "details.batchMongoId": { $in: [...batchKeys] } },
    ],
  })
    .select("admissionId applicant course status details")
    .limit(500)
    .lean()
    .maxTimeMS(8000);

  const rows = admissions.map((a) => {
    const details = a.details && typeof a.details === "object" ? a.details : {};
    const batch = batchById.get(String(details.batchMongoId)) || null;
    return {
      _id: String(a._id),
      name: details.nameEnglish || a.applicant || "—",
      admissionId: a.admissionId || "",
      course: a.course || batch?.courseName || "",
      semester: details.currentSemester || details.semester || "",
      batch: batch?.name || "",
      status: a.status,
    };
  });

  return { rows, total: rows.length };
}

export async function getFacultyExams(facultyId) {
  const faculty = await findFacultyDoc(facultyId);
  if (!faculty) throw notFound("Faculty not found");
  // No Exams module exists yet in this codebase — return a truthful empty
  // state rather than fabricating exam records.
  return { rows: [], total: 0, message: "Exams module is not implemented yet" };
}
