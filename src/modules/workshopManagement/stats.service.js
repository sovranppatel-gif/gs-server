import { WorkshopRegistration } from "../workshop/workshop.model.js";
import {
  WorkshopSession,
  WorkshopAttendance,
  WorkshopTask,
  WorkshopTaskSubmission,
} from "./workshopManagement.model.js";
import { percent, todayIST } from "./workshopManagement.utils.js";

/**
 * Rejected registrations are kept in the database but are not counted as
 * workshop participants (not eligible for attendance, reports or reminders).
 */
export const PARTICIPANT_FILTER = { status: { $ne: "Rejected" } };

export function sortSessions(a, b) {
  return (
    a.dayNumber - b.dayNumber ||
    String(a.date).localeCompare(String(b.date)) ||
    String(a.startTime).localeCompare(String(b.startTime))
  );
}

/**
 * A session "counts" toward attendance % once it has happened: not cancelled,
 * and either already marked Live/Completed or its date is today or earlier.
 * Future sessions show as "–" instead of dragging percentages down.
 */
export function isSessionHeld(session, today = todayIST()) {
  if (session.status === "Cancelled") return false;
  if (session.status === "Live" || session.status === "Completed") return true;
  return String(session.date) <= today;
}

export async function loadWorkshopContext({ withTasks = false } = {}) {
  const today = todayIST();
  const [students, sessions, attendance] = await Promise.all([
    WorkshopRegistration.find(PARTICIPANT_FILTER).sort({ createdAt: -1 }).lean(),
    WorkshopSession.find().lean(),
    WorkshopAttendance.find({}, { sessionId: 1, registrationId: 1, status: 1, markedAt: 1, markedBy: 1 }).lean(),
  ]);

  sessions.sort(sortSessions);
  const heldSessions = sessions.filter((s) => isSessionHeld(s, today));
  const heldIds = new Set(heldSessions.map((s) => String(s._id)));

  // registrationId → Map(sessionId → attendance row)
  const byStudent = new Map();
  for (const row of attendance) {
    const key = row.registrationId;
    if (!byStudent.has(key)) byStudent.set(key, new Map());
    byStudent.get(key).set(String(row.sessionId), row);
  }

  let tasks = [];
  let submissionsByStudent = new Map();
  if (withTasks) {
    const [taskDocs, submissions] = await Promise.all([
      WorkshopTask.find({ status: { $ne: "Draft" } }).lean(),
      WorkshopTaskSubmission.find({ status: { $ne: "Rejected" } }, { registrationId: 1, taskId: 1, status: 1 }).lean(),
    ]);
    tasks = taskDocs;
    const activeTaskIds = new Set(taskDocs.map((t) => String(t._id)));
    submissionsByStudent = new Map();
    for (const sub of submissions) {
      if (!activeTaskIds.has(String(sub.taskId))) continue;
      submissionsByStudent.set(sub.registrationId, (submissionsByStudent.get(sub.registrationId) || 0) + 1);
    }
  }

  return { today, students, sessions, heldSessions, heldIds, byStudent, tasks, submissionsByStudent };
}

export function studentAttendanceStats(ctx, student) {
  const records = ctx.byStudent.get(student.registrationId) || new Map();
  let present = 0;
  for (const session of ctx.heldSessions) {
    if (records.get(String(session._id))?.status === "Present") present += 1;
  }
  const total = ctx.heldSessions.length;
  return {
    totalSessions: total,
    present,
    absent: total - present,
    attendancePercent: percent(present, total),
  };
}

/** Per-session cell for a student: Present | Absent | Upcoming | Cancelled */
export function sessionCell(ctx, student, session) {
  const record = ctx.byStudent.get(student.registrationId)?.get(String(session._id));
  if (session.status === "Cancelled") return { status: "Cancelled", record: null };
  if (record) return { status: record.status, record };
  if (!ctx.heldIds.has(String(session._id))) return { status: "Upcoming", record: null };
  return { status: "Absent", record: null };
}

export function studentRow(ctx, student) {
  const stats = studentAttendanceStats(ctx, student);
  return {
    _id: student._id,
    registrationId: student.registrationId,
    fullName: student.fullName,
    mobile: student.mobile,
    email: student.email,
    whatsappNumber: student.whatsappNumber,
    collegeName: student.collegeName,
    course: student.course,
    semesterYear: student.semesterYear,
    referralCode: student.referralCode,
    status: student.status,
    createdAt: student.createdAt,
    ...stats,
    sessionsAttended: stats.present,
    tasksCompleted: ctx.submissionsByStudent.get(student.registrationId) || 0,
  };
}

export function sessionSummary(ctx, session) {
  let present = 0;
  for (const student of ctx.students) {
    if (ctx.byStudent.get(student.registrationId)?.get(String(session._id))?.status === "Present") {
      present += 1;
    }
  }
  const totalRegistered = ctx.students.length;
  const held = ctx.heldIds.has(String(session._id));
  return {
    totalRegistered,
    present,
    absent: held ? totalRegistered - present : 0,
    notMarked: held ? 0 : totalRegistered - present,
    attendancePercent: percent(present, totalRegistered),
    held,
  };
}

/** The session to feature as "today's": today's date first, else a Live one. */
export function pickTodaySession(ctx) {
  const live = ctx.sessions.find((s) => s.status === "Live");
  const todays = ctx.sessions.filter((s) => s.date === ctx.today && s.status !== "Cancelled");
  return todays[0] || live || null;
}

export function pickUpcomingSession(ctx, excludeId) {
  return (
    ctx.sessions.find(
      (s) =>
        String(s._id) !== String(excludeId || "") &&
        s.status !== "Cancelled" &&
        s.status !== "Completed" &&
        String(s.date) >= ctx.today &&
        !(s.date === ctx.today && s.status === "Live")
    ) || null
  );
}
