import mongoose from "mongoose";
import { Admission } from "../../models/Admission.js";
import { Course } from "../courses/courses.model.js";
import { University } from "../universities/universities.model.js";
import {
  Attendance,
  ATTENDANCE_STATUSES,
  ATTENDANCE_METHODS,
} from "./attendance.model.js";
import { allocateAttendanceId } from "./attendanceIds.js";
import { emitSectionUpdate } from "../../lib/socket.js";
import { createActivityLog } from "../activityLog/activityLog.service.js";

function dayStart(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
  }
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDateLabel(value) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

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

function idVariants(value) {
  const oid = asObjectId(value);
  if (!oid) return [];
  return [oid, String(oid)];
}

async function nextAttendanceId() {
  return allocateAttendanceId();
}

function studentName(admission) {
  const details =
    admission?.details && typeof admission.details === "object"
      ? admission.details
      : {};
  return (
    String(details.nameEnglish || "").trim() ||
    String(admission?.applicant || "").trim() ||
    "—"
  );
}

function buildAdmissionMatch({ universityId, courseId, courseName, courseCode }) {
  const uniIds = idVariants(universityId);
  const courseIds = idVariants(courseId);
  const courseLabel = String(courseName || "").trim();
  const codeLabel = String(courseCode || "").trim();

  const and = [{ status: "Approved" }];

  const courseOr = [];
  if (courseIds.length) {
    courseOr.push(
      { "details.courseId": { $in: courseIds } },
      { courseId: { $in: courseIds } }
    );
  }
  if (courseLabel) {
    const rx = new RegExp(escapeRegex(courseLabel), "i");
    courseOr.push(
      { course: rx },
      { "details.course": rx },
      { "details.courseName": rx }
    );
  }
  if (codeLabel) {
    const rx = new RegExp(escapeRegex(codeLabel), "i");
    courseOr.push(
      { course: rx },
      { "details.courseCode": rx },
      { "details.course": rx }
    );
  }
  if (courseOr.length) and.push({ $or: courseOr });

  // University is optional soft filter — many admissions lack valid universityId
  if (uniIds.length && !courseOr.length) {
    and.push({
      $or: [
        { "details.universityId": { $in: uniIds } },
        { universityId: { $in: uniIds } },
      ],
    });
  }

  return { $and: and };
}

function normalizeCourseKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function coursesLikelyMatch(admissionCourse, courseName, courseCode) {
  const a = normalizeCourseKey(admissionCourse);
  const name = normalizeCourseKey(courseName);
  const code = normalizeCourseKey(courseCode);
  if (!a) return false;
  if (name && (a === name || a.includes(name) || name.includes(a))) return true;
  if (code && (a.includes(code) || a.includes(code.replace(/\s/g, "")))) return true;
  const paren = String(admissionCourse || "").match(/\(([^)]+)\)/);
  if (paren?.[1]) {
    const p = normalizeCourseKey(paren[1]);
    if (code && (p === code || code.includes(p) || p.includes(code))) return true;
  }
  if (
    /full\s*stack|mern|react.*node/.test(a) &&
    /full\s*stack|web\s*development|mern/.test(name)
  ) {
    return true;
  }
  if (/^bca\b/.test(a) && /^bca\b/.test(name)) return true;
  return false;
}

async function findRosterAdmissions(scope) {
  let admissions = await Admission.find(
    buildAdmissionMatch({
      universityId: scope.universityId,
      courseId: scope.courseId,
      courseName: scope.courseName,
      courseCode: scope.courseCode,
    })
  )
    .sort({ applicant: 1, createdAt: -1 })
    .lean()
    .maxTimeMS(12000);

  if (!admissions.length) {
    const allApproved = await Admission.find({ status: "Approved" })
      .sort({ applicant: 1, createdAt: -1 })
      .lean()
      .maxTimeMS(12000);
    admissions = allApproved.filter((adm) =>
      coursesLikelyMatch(
        adm.course || adm.details?.course || "",
        scope.courseName,
        scope.courseCode
      )
    );
  }

  return admissions;
}

function applySearchFilter(rows, search) {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => {
    const hay = [
      row.student,
      row.name,
      row.email,
      row.phone,
      row.admissionId,
      row.courseName,
      row.course,
      row.courseCode,
      row.universityName,
      row.semester,
      row.semesterTitle,
      row.status,
      row.method,
      row.attendanceId,
    ]
      .map((v) => String(v ?? "").toLowerCase())
      .join(" ");
    return hay.includes(q);
  });
}

function computeStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = {
    total: list.length,
    present: 0,
    absent: 0,
    late: 0,
    leave: 0,
    unmarked: 0,
  };
  for (const row of list) {
    const status = String(row.status || "").toLowerCase();
    if (status === "present") counts.present += 1;
    else if (status === "absent") counts.absent += 1;
    else if (status === "late") counts.late += 1;
    else if (status === "leave") counts.leave += 1;
    else if (status === "holiday") counts.leave += 1;
    else counts.unmarked += 1;
  }
  const marked = counts.total - counts.unmarked;
  const presentLike = counts.present + counts.late;
  counts.percent =
    marked > 0 ? Math.round((presentLike / marked) * 100) : 0;
  return counts;
}

function toRow(doc, extras = {}) {
  const date = doc.date || extras.date;
  return {
    id: doc._id ? String(doc._id) : extras.id || "",
    _id: doc._id ? String(doc._id) : extras.id || "",
    attendanceId: doc.attendanceId || extras.attendanceId || "",
    admissionId: doc.admissionId || extras.admissionId || "",
    admissionMongoId: doc.admissionMongoId
      ? String(doc.admissionMongoId)
      : extras.admissionMongoId || "",
    student: doc.student || extras.student || "—",
    name: doc.student || extras.student || "—",
    email: doc.email || extras.email || "",
    phone: doc.phone || extras.phone || "",
    universityId: doc.universityId
      ? String(doc.universityId)
      : extras.universityId || "",
    universityName: doc.universityName || extras.universityName || "",
    courseId: doc.courseId ? String(doc.courseId) : extras.courseId || "",
    courseName: doc.courseName || extras.courseName || "",
    course: doc.courseName || extras.courseName || "",
    courseCode: doc.courseCode || extras.courseCode || "",
    semester: doc.semester ?? extras.semester ?? "",
    semesterTitle: doc.semesterTitle || extras.semesterTitle || "",
    date: date ? new Date(date).toISOString() : "",
    dateLabel: formatDateLabel(date),
    status: doc.status || extras.status || "Unmarked",
    method: doc.method || extras.method || "",
    note: doc.note || extras.note || "",
    markedBy: doc.markedBy || extras.markedBy || "",
    marked: Boolean(doc._id || doc.attendanceId),
  };
}

async function resolveScope({ universityId, courseId, semester }) {
  const uniOid = asObjectId(universityId);
  const courseOid = asObjectId(courseId);
  const sem = Number(semester);

  if (!uniOid) {
    const err = new Error("University is required");
    err.status = 400;
    throw err;
  }
  if (!courseOid) {
    const err = new Error("Course is required");
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(sem) || sem < 1) {
    const err = new Error("Semester is required");
    err.status = 400;
    throw err;
  }

  const [university, course] = await Promise.all([
    University.findOne({ _id: uniOid, softDelete: false })
      .select("name shortName")
      .lean()
      .maxTimeMS(8000),
    Course.findOne({ _id: courseOid, softDelete: false })
      .select("name code universityId universityName semesters semesterCount")
      .lean()
      .maxTimeMS(8000),
  ]);

  if (!university) {
    const err = new Error("University not found");
    err.status = 404;
    throw err;
  }
  if (!course) {
    const err = new Error("Course not found");
    err.status = 404;
    throw err;
  }

  // Institute / unlinked courses can be opened under any university scope
  if (
    course.universityId &&
    String(course.universityId) !== String(uniOid)
  ) {
    const err = new Error("Course does not belong to selected university");
    err.status = 400;
    throw err;
  }

  const semesterMeta = (course.semesters || []).find(
    (s) => Number(s.number) === sem
  );
  // If course has no semester list, still allow Sem 1+
  const maxSem =
    Number(course.semesterCount) ||
    (Array.isArray(course.semesters) ? course.semesters.length : 0) ||
    0;
  if (maxSem > 0 && sem > maxSem) {
    const err = new Error(`Semester ${sem} is not available for this course`);
    err.status = 400;
    throw err;
  }

  return {
    universityId: uniOid,
    universityName: university.name || university.shortName || "",
    courseId: courseOid,
    courseName: course.name || "",
    courseCode: course.code || "",
    semester: sem,
    semesterTitle:
      semesterMeta?.title ||
      (semesterMeta?.number ? `Semester ${semesterMeta.number}` : `Semester ${sem}`),
  };
}

/**
 * Global overview for StatCards — all approved students + marks for the date.
 * Does not require university/course/semester filters.
 */
export async function getAttendanceOverview(params = {}) {
  const targetDate = dayStart(params.date);

  const [approvedCount, marks] = await Promise.all([
    Admission.countDocuments({ status: "Approved" }).maxTimeMS(8000),
    Attendance.find({ date: targetDate })
      .select("status admissionMongoId")
      .lean()
      .maxTimeMS(10000),
  ]);

  // One mark per student (latest / first) for the day
  const byStudent = new Map();
  for (const m of marks) {
    const key = String(m.admissionMongoId || m._id);
    if (!byStudent.has(key)) byStudent.set(key, m);
  }

  const uniqueMarks = [...byStudent.values()];
  const stats = computeStats(
    uniqueMarks.map((m) => ({ status: m.status || "Unmarked" }))
  );

  // Total students = all approved; unmarked = approved without a mark today
  const markedStudents = uniqueMarks.length;
  stats.total = approvedCount;
  stats.unmarked = Math.max(0, approvedCount - markedStudents);
  const presentLike = (stats.present || 0) + (stats.late || 0);
  const denom = markedStudents > 0 ? markedStudents : approvedCount;
  stats.percent =
    denom > 0 ? Math.round((presentLike / denom) * 100) : 0;
  stats.marked = markedStudents;

  return {
    stats,
    meta: {
      overview: true,
      date: targetDate.toISOString(),
      dateLabel: formatDateLabel(targetDate),
      approvedCount,
      markedCount: markedStudents,
    },
  };
}

/**
 * Cascaded list: only loads after university + course + semester are chosen.
 * Merges approved admissions (roster) with attendance marks for the date.
 */
export async function listAttendance(params = {}) {
  const {
    universityId = "",
    courseId = "",
    semester = "",
    date = "",
    search = "",
    status = "",
  } = params;

  if (!universityId || !courseId || !semester) {
    return {
      rows: [],
      stats: computeStats([]),
      meta: {
        requiresFilters: true,
        message: "Select university, course and semester to load attendance",
      },
    };
  }

  const scope = await resolveScope({ universityId, courseId, semester });
  const targetDate = dayStart(date);

  const [admissions, marks] = await Promise.all([
    findRosterAdmissions(scope),
    Attendance.find({
      courseId: scope.courseId,
      semester: scope.semester,
      date: targetDate,
    })
      .lean()
      .maxTimeMS(8000),
  ]);

  const markByAdmission = new Map(
    marks.map((m) => [String(m.admissionMongoId), m])
  );

  let rows = admissions.map((adm) => {
    const mark = markByAdmission.get(String(adm._id));
    const details =
      adm.details && typeof adm.details === "object" ? adm.details : {};
    const baseExtras = {
      admissionId: adm.admissionId,
      admissionMongoId: String(adm._id),
      student: studentName(adm),
      email: adm.email || details.email || "",
      phone: adm.phone || details.studentMobile || details.contactNo || "",
      universityId: String(scope.universityId),
      universityName:
        scope.universityName ||
        details.universityName ||
        adm.college ||
        "",
      courseId: String(scope.courseId),
      courseName: scope.courseName || adm.course || "",
      courseCode: scope.courseCode || details.courseCode || "",
      semester: scope.semester,
      semesterTitle: scope.semesterTitle,
      date: targetDate,
      status: "Unmarked",
      method: "",
    };
    if (mark) {
      markByAdmission.delete(String(adm._id));
      return toRow(mark, baseExtras);
    }
    return toRow({}, baseExtras);
  });

  // Include seeded/marked attendance even if admission roster fuzzy-match missed them
  for (const mark of markByAdmission.values()) {
    rows.push(toRow(mark, {
      universityId: String(scope.universityId),
      universityName: scope.universityName,
      courseId: String(scope.courseId),
      courseName: scope.courseName,
      courseCode: scope.courseCode,
      semester: scope.semester,
      semesterTitle: scope.semesterTitle,
      date: targetDate,
    }));
  }

  if (status) {
    const wanted = String(status).trim().toLowerCase();
    rows = rows.filter((r) => String(r.status || "").toLowerCase() === wanted);
  }

  rows = applySearchFilter(rows, search);

  return {
    rows,
    stats: computeStats(rows),
    meta: {
      requiresFilters: false,
      universityId: String(scope.universityId),
      universityName: scope.universityName,
      courseId: String(scope.courseId),
      courseName: scope.courseName,
      courseCode: scope.courseCode,
      semester: scope.semester,
      semesterTitle: scope.semesterTitle,
      date: targetDate.toISOString(),
      dateLabel: formatDateLabel(targetDate),
      rosterCount: admissions.length,
      markedCount: marks.length,
    },
  };
}

export async function markBulkAttendance(payload = {}, editor = "master-admin") {
  const {
    universityId,
    courseId,
    semester,
    date,
    method = "Manual",
    records = [],
  } = payload;

  if (!Array.isArray(records) || records.length === 0) {
    const err = new Error("At least one attendance record is required");
    err.status = 400;
    throw err;
  }

  const scope = await resolveScope({ universityId, courseId, semester });
  const targetDate = dayStart(date);
  const methodSafe = ATTENDANCE_METHODS.includes(method) ? method : "Manual";

  const admissionIds = records
    .map((r) => asObjectId(r.admissionMongoId || r.admissionId || r.id))
    .filter(Boolean);

  const admissions = await Admission.find({
    _id: { $in: admissionIds },
    status: "Approved",
  })
    .lean()
    .maxTimeMS(10000);

  const admissionMap = new Map(admissions.map((a) => [String(a._id), a]));
  const results = [];

  for (const item of records) {
    const admOid = asObjectId(item.admissionMongoId || item.id);
    const admission =
      (admOid && admissionMap.get(String(admOid))) ||
      admissions.find(
        (a) =>
          a.admissionId === item.admissionId ||
          String(a._id) === String(item.admissionMongoId || "")
      );

    if (!admission) continue;

    const statusRaw = String(item.status || "Present").trim();
    const status = ATTENDANCE_STATUSES.includes(statusRaw)
      ? statusRaw
      : "Present";
    const itemMethod = ATTENDANCE_METHODS.includes(item.method)
      ? item.method
      : methodSafe;

    const details =
      admission.details && typeof admission.details === "object"
        ? admission.details
        : {};

    const existing = await Attendance.findOne({
      admissionMongoId: admission._id,
      courseId: scope.courseId,
      semester: scope.semester,
      date: targetDate,
    });

    let doc;
    if (existing) {
      existing.status = status;
      existing.method = itemMethod;
      existing.note = String(item.note || existing.note || "").trim();
      existing.markedBy = editor;
      existing.student = studentName(admission);
      existing.email = admission.email || details.email || existing.email;
      existing.phone =
        admission.phone ||
        details.studentMobile ||
        details.contactNo ||
        existing.phone;
      existing.universityName = scope.universityName;
      existing.courseName = scope.courseName;
      existing.courseCode = scope.courseCode;
      existing.semesterTitle = scope.semesterTitle;
      doc = await existing.save();
    } else {
      doc = await Attendance.create({
        attendanceId: await nextAttendanceId(),
        admissionId: admission.admissionId,
        admissionMongoId: admission._id,
        student: studentName(admission),
        email: admission.email || details.email || "",
        phone:
          admission.phone ||
          details.studentMobile ||
          details.contactNo ||
          "",
        universityId: scope.universityId,
        universityName: scope.universityName,
        courseId: scope.courseId,
        courseName: scope.courseName,
        courseCode: scope.courseCode,
        semester: scope.semester,
        semesterTitle: scope.semesterTitle,
        date: targetDate,
        status,
        method: itemMethod,
        note: String(item.note || "").trim(),
        markedBy: editor,
      });
    }

    results.push(toRow(doc.toObject ? doc.toObject() : doc));
  }

  await createActivityLog({
    section: "Attendance",
    action: "mark",
    actor: editor,
    resourceId: `${scope.courseCode || scope.courseId}-S${scope.semester}`,
    message: `Marked attendance for ${results.length} student(s) — ${scope.courseName} Sem ${scope.semester} (${formatDateLabel(targetDate)})`,
    path: "/api/attendance/bulk",
  });

  emitSectionUpdate({
    section: "Attendance",
    action: "mark",
    message: `Attendance updated (${results.length})`,
    at: new Date().toISOString(),
  });

  const list = await listAttendance({
    universityId: String(scope.universityId),
    courseId: String(scope.courseId),
    semester: scope.semester,
    date: targetDate.toISOString(),
  });

  return {
    marked: results.length,
    rows: list.rows,
    stats: list.stats,
    meta: list.meta,
  };
}

export async function updateAttendance(id, payload = {}, editor = "master-admin") {
  const oid = asObjectId(id);
  const query = oid
    ? { _id: oid }
    : { attendanceId: String(id || "").trim() };

  const doc = await Attendance.findOne(query);
  if (!doc) {
    const err = new Error("Attendance record not found");
    err.status = 404;
    throw err;
  }

  if (payload.status != null) {
    const status = String(payload.status).trim();
    if (!ATTENDANCE_STATUSES.includes(status)) {
      const err = new Error("Invalid attendance status");
      err.status = 400;
      throw err;
    }
    doc.status = status;
  }

  if (payload.method != null) {
    const method = String(payload.method).trim();
    if (ATTENDANCE_METHODS.includes(method)) doc.method = method;
  }

  if (payload.note != null) {
    doc.note = String(payload.note).trim();
  }

  doc.markedBy = editor;
  await doc.save();

  await createActivityLog({
    section: "Attendance",
    action: "update",
    actor: editor,
    resourceId: doc.attendanceId,
    message: `Updated attendance ${doc.attendanceId} → ${doc.status}`,
    path: `/api/attendance/${doc.attendanceId}`,
  });

  emitSectionUpdate({
    section: "Attendance",
    action: "update",
    resourceId: doc.attendanceId,
    message: `Attendance ${doc.attendanceId} updated`,
    at: new Date().toISOString(),
  });

  return toRow(doc.toObject());
}

/**
 * Lightweight search across marked attendance (still scoped when filters given).
 * Used by the search box when user types name / course / sem etc.
 */
export async function searchAttendance(params = {}) {
  const {
    universityId = "",
    courseId = "",
    semester = "",
    search = "",
    date = "",
    limit = 50,
  } = params;

  // Prefer scoped merged list when cascade filters are complete
  if (universityId && courseId && semester) {
    return listAttendance({
      universityId,
      courseId,
      semester,
      date,
      search,
    });
  }

  const q = String(search || "").trim();
  if (!q) {
    return {
      rows: [],
      stats: computeStats([]),
      meta: {
        requiresFilters: true,
        message: "Select filters or enter a search term",
      },
    };
  }

  const query = {};
  const uniOid = asObjectId(universityId);
  const courseOid = asObjectId(courseId);
  if (uniOid) query.universityId = uniOid;
  if (courseOid) query.courseId = courseOid;
  if (semester) {
    const sem = Number(semester);
    if (Number.isFinite(sem) && sem > 0) query.semester = sem;
  }
  if (date) query.date = dayStart(date);

  const rx = new RegExp(escapeRegex(q), "i");
  query.$or = [
    { student: rx },
    { email: rx },
    { admissionId: rx },
    { attendanceId: rx },
    { courseName: rx },
    { courseCode: rx },
    { universityName: rx },
    { semesterTitle: rx },
    { status: rx },
  ];

  // Also allow numeric semester search via free text
  const maybeSem = Number(q);
  if (Number.isFinite(maybeSem) && maybeSem > 0) {
    query.$or.push({ semester: maybeSem });
  }

  const docs = await Attendance.find(query)
    .sort({ date: -1, student: 1 })
    .limit(Math.min(Number(limit) || 50, 100))
    .lean()
    .maxTimeMS(10000);

  const rows = docs.map((d) => toRow(d));
  return {
    rows,
    stats: computeStats(rows),
    meta: {
      requiresFilters: false,
      searchOnly: true,
      total: rows.length,
    },
  };
}

const STATUS_RANK = {
  holiday: 1,
  present: 2,
  late: 3,
  leave: 4,
  absent: 5,
};

function statusKey(status) {
  const s = String(status || "").trim().toLowerCase();
  if (STATUS_RANK[s]) return s;
  return "";
}

function monthKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function monthLabelFromKey(key) {
  const [ys, ms] = String(key || "").split("-");
  const y = Number(ys);
  const m = Number(ms);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return key || "—";
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
  });
}

function shortMonth(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { month: "short" });
}

/**
 * Student portal — own attendance summary (calendar, trend, course-wise).
 */
export async function getStudentMyAttendance({ email, year, month } = {}) {
  const normalizedEmail = String(email || "")
    .toLowerCase()
    .trim();
  if (!normalizedEmail) {
    const err = new Error("Student email is required");
    err.status = 401;
    throw err;
  }

  const admissions = await Admission.find({
    email: normalizedEmail,
    status: "Approved",
  })
    .select("_id admissionId course details")
    .lean()
    .maxTimeMS(8000);

  const admissionMongoIds = admissions.map((a) => a._id).filter(Boolean);
  const admissionCodes = admissions
    .map((a) => String(a.admissionId || "").trim())
    .filter(Boolean);

  const or = [{ email: normalizedEmail }];
  if (admissionMongoIds.length) {
    or.push({ admissionMongoId: { $in: admissionMongoIds } });
  }
  if (admissionCodes.length) {
    or.push({ admissionId: { $in: admissionCodes } });
  }

  const docs = await Attendance.find({ $or: or })
    .sort({ date: 1 })
    .lean()
    .maxTimeMS(12000);

  const now = new Date();
  let y = Number(year);
  let m = Number(month); // 1-12
  if (!Number.isFinite(y) || y < 2000 || y > 2100) y = now.getFullYear();
  if (!Number.isFinite(m) || m < 1 || m > 12) m = now.getMonth() + 1;

  const selectedKey = `${y}-${String(m).padStart(2, "0")}`;
  const monthStart = new Date(y, m - 1, 1);
  monthStart.setHours(0, 0, 0, 0);
  const monthEnd = new Date(y, m, 0, 23, 59, 59, 999);
  const daysInMonth = monthEnd.getDate();

  // Overall stats (all time)
  let presentDays = 0;
  let absentDays = 0;
  let lateDays = 0;
  let leaveDays = 0;
  let holidayDays = 0;

  // Calendar: one status per day (worst wins)
  const calendarDays = {};
  // Trend buckets by YYYY-MM
  const trendMap = new Map();
  // Course / subject buckets
  const subjectMap = new Map();

  const monthKeysSet = new Set();

  for (const doc of docs) {
    const date = doc.date ? new Date(doc.date) : null;
    if (!date || Number.isNaN(date.getTime())) continue;

    const key = monthKey(date);
    if (key) monthKeysSet.add(key);

    const status = statusKey(doc.status);
    if (!status) continue;

    // Overall counts (per record)
    if (status === "present") presentDays += 1;
    else if (status === "absent") absentDays += 1;
    else if (status === "late") lateDays += 1;
    else if (status === "leave") leaveDays += 1;
    else if (status === "holiday") holidayDays += 1;

    // Selected month calendar
    if (date >= monthStart && date <= monthEnd) {
      const day = date.getDate();
      const prev = calendarDays[day];
      if (!prev || (STATUS_RANK[status] || 0) > (STATUS_RANK[prev] || 0)) {
        calendarDays[day] = status;
      }
    }

    // Monthly trend
    if (!trendMap.has(key)) {
      trendMap.set(key, {
        key,
        month: shortMonth(date),
        present: 0,
        absent: 0,
        late: 0,
        leave: 0,
        holiday: 0,
      });
    }
    const bucket = trendMap.get(key);
    if (status === "present") bucket.present += 1;
    else if (status === "absent") bucket.absent += 1;
    else if (status === "late") bucket.late += 1;
    else if (status === "leave") bucket.leave += 1;
    else if (status === "holiday") bucket.holiday += 1;

    // Course-wise (treat course as subject for portal UI)
    const subject =
      String(doc.courseName || doc.courseCode || "").trim() ||
      "General";
    if (!subjectMap.has(subject)) {
      subjectMap.set(subject, {
        subject,
        present: 0,
        absent: 0,
        late: 0,
        leave: 0,
        holiday: 0,
      });
    }
    const sub = subjectMap.get(subject);
    if (status === "present") sub.present += 1;
    else if (status === "absent") sub.absent += 1;
    else if (status === "late") sub.late += 1;
    else if (status === "leave") sub.leave += 1;
    else if (status === "holiday") sub.holiday += 1;
  }

  // Ensure current / selected month appears in filter even with no marks
  monthKeysSet.add(selectedKey);
  const months = [...monthKeysSet]
    .sort()
    .reverse()
    .map((key) => ({
      value: key,
      label: monthLabelFromKey(key),
    }));

  const trend = [...trendMap.values()]
    .sort((a, b) => String(a.key).localeCompare(String(b.key)))
    .slice(-8)
    .map((row) => {
      const marked =
        row.present + row.absent + row.late + row.leave + row.holiday;
      const presentLike = row.present + row.late;
      return {
        month: row.month,
        present: row.present,
        absent: row.absent,
        late: row.late,
        leave: row.leave,
        percent: marked > 0 ? Math.round((presentLike / marked) * 100) : 0,
      };
    });

  const subjects = [...subjectMap.values()]
    .map((row) => {
      const marked =
        row.present + row.absent + row.late + row.leave + row.holiday;
      const presentLike = row.present + row.late;
      return {
        subject: row.subject,
        present: row.present,
        absent: row.absent,
        late: row.late,
        leave: row.leave,
        percent: marked > 0 ? Math.round((presentLike / marked) * 100) : 0,
      };
    })
    .sort((a, b) => b.percent - a.percent || a.subject.localeCompare(b.subject));

  const totalMarked =
    presentDays + absentDays + lateDays + leaveDays + holidayDays;
  const presentLike = presentDays + lateDays;
  const attendancePercent =
    totalMarked > 0 ? Math.round((presentLike / totalMarked) * 100) : 0;

  const monthRows = docs
    .filter((doc) => {
      const date = doc.date ? new Date(doc.date) : null;
      return date && date >= monthStart && date <= monthEnd;
    })
    .map((d) => toRow(d));

  return {
    stats: {
      attendancePercent,
      presentDays,
      absentDays,
      lateDays,
      leaveDays,
      holidayDays,
      totalMarked,
    },
    calendar: {
      year: y,
      monthIndex: m - 1,
      month: monthLabelFromKey(selectedKey),
      daysInMonth,
      days: calendarDays,
    },
    trend,
    subjects,
    months,
    rows: monthRows,
    meta: {
      email: normalizedEmail,
      admissions: admissions.length,
      records: docs.length,
      selectedMonth: selectedKey,
      hasData: docs.length > 0,
    },
  };
}

