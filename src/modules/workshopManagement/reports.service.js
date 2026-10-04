import { WorkshopRegistration, WorkshopReferralLink } from "../workshop/workshop.model.js";
import { WorkshopAttendance, WorkshopWhatsappMessage } from "./workshopManagement.model.js";
import { HttpError, percent, formatDateLong, formatTimeRange } from "./workshopManagement.utils.js";
import { getSettings, attendanceUrl } from "./settings.service.js";
import {
  loadWorkshopContext,
  studentRow,
  sessionSummary,
  pickTodaySession,
  pickUpcomingSession,
} from "./stats.service.js";
import { listTasks } from "./tasks.service.js";
import { summarizeMessage } from "./whatsapp.service.js";
import { getEligibility } from "./certificates.service.js";

function overallAttendance(ctx) {
  const possible = ctx.students.length * ctx.heldSessions.length;
  if (!possible) return 0;
  let present = 0;
  for (const records of ctx.byStudent.values()) {
    for (const [sessionId, row] of records) {
      if (row.status === "Present" && ctx.heldIds.has(sessionId)) present += 1;
    }
  }
  return percent(present, possible);
}

function sessionCard(ctx, settings, session) {
  if (!session) return null;
  return {
    _id: session._id,
    slug: session.slug,
    dayNumber: session.dayNumber,
    title: session.title,
    date: session.date,
    dateLabel: formatDateLong(session.date),
    timeLabel: formatTimeRange(session.startTime, session.endTime),
    status: session.status,
    trainer: session.trainer,
    attendanceUrl: attendanceUrl(settings, session),
    summary: sessionSummary(ctx, session),
  };
}

export async function getDashboard() {
  const [ctx, settings] = await Promise.all([loadWorkshopContext(), getSettings()]);
  const today = pickTodaySession(ctx);
  const upcoming = pickUpcomingSession(ctx, today?._id);

  const recentAttendance = await WorkshopAttendance.find()
    .sort({ markedAt: -1 })
    .limit(10)
    .populate("sessionId", "dayNumber title")
    .populate("registration", "fullName collegeName")
    .lean();

  const colleges = new Set(ctx.students.map((s) => (s.collegeName || "").trim().toLowerCase()).filter(Boolean));

  return {
    workshopName: settings.workshopName,
    totals: {
      students: ctx.students.length,
      colleges: colleges.size,
      sessions: ctx.sessions.filter((s) => s.status !== "Cancelled").length,
      sessionsHeld: ctx.heldSessions.length,
      overallAttendancePercent: overallAttendance(ctx),
    },
    todaySession: sessionCard(ctx, settings, today),
    upcomingSession: sessionCard(ctx, settings, upcoming),
    recentRegistrations: ctx.students.slice(0, 8).map((s) => ({
      _id: s._id,
      registrationId: s.registrationId,
      fullName: s.fullName,
      collegeName: s.collegeName,
      createdAt: s.createdAt,
    })),
    recentAttendance: recentAttendance.map((a) => ({
      _id: a._id,
      registrationId: a.registrationId,
      fullName: a.registration?.fullName || "",
      collegeName: a.registration?.collegeName || "",
      session: a.sessionId ? `Day ${a.sessionId.dayNumber} – ${a.sessionId.title}` : "",
      status: a.status,
      markedAt: a.markedAt,
      markedBy: a.markedBy,
    })),
  };
}

// ---------------------------------------------------------------------------
// Reports: each returns { columns, rows } so the UI can render + export CSV.
// ---------------------------------------------------------------------------

const col = (key, label) => ({ key, label });

async function registrationReport() {
  const rows = await WorkshopRegistration.find().sort({ createdAt: -1 }).lean();
  return {
    columns: [
      col("registrationId", "Registration ID"),
      col("fullName", "Name"),
      col("mobile", "Mobile"),
      col("email", "Email"),
      col("collegeName", "College"),
      col("course", "Course"),
      col("semesterYear", "Semester/Year"),
      col("referralCode", "Referral"),
      col("status", "Status"),
      col("registeredOn", "Registered On"),
    ],
    rows: rows.map((r) => ({ ...r, referralCode: r.referralCode || "Direct", registeredOn: new Date(r.createdAt).toISOString().slice(0, 10) })),
  };
}

async function collegeReport() {
  const [ctx, links] = await Promise.all([loadWorkshopContext(), WorkshopReferralLink.find().lean()]);
  const linkByCollege = new Map(links.map((l) => [l.collegeName.trim().toLowerCase(), l.referralCode]));
  const groups = new Map();
  for (const s of ctx.students) {
    const name = (s.collegeName || "Unknown").trim();
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { collegeName: name, students: 0, present: 0 });
    const g = groups.get(key);
    const stats = studentRow(ctx, s);
    g.students += 1;
    g.present += stats.present;
  }
  const held = ctx.heldSessions.length;
  return {
    columns: [
      col("collegeName", "College"),
      col("referralCode", "Referral Code"),
      col("students", "Students"),
      col("present", "Total Present"),
      col("attendancePercent", "Attendance %"),
    ],
    rows: [...groups.entries()]
      .map(([key, g]) => ({
        ...g,
        referralCode: linkByCollege.get(key) || "",
        attendancePercent: percent(g.present, g.students * held),
      }))
      .sort((a, b) => b.students - a.students),
  };
}

async function sessionReport() {
  const [ctx, settings] = await Promise.all([loadWorkshopContext(), getSettings()]);
  return {
    columns: [
      col("day", "Day"),
      col("title", "Session"),
      col("date", "Date"),
      col("time", "Time"),
      col("status", "Status"),
      col("totalRegistered", "Registered"),
      col("present", "Present"),
      col("absent", "Absent"),
      col("attendancePercent", "Attendance %"),
      col("attendanceUrl", "Attendance Link"),
    ],
    rows: ctx.sessions.map((s) => {
      const summary = sessionSummary(ctx, s);
      return {
        _id: s._id,
        day: `Day ${s.dayNumber}`,
        title: s.title,
        date: s.date,
        time: formatTimeRange(s.startTime, s.endTime),
        status: s.status,
        ...summary,
        attendanceUrl: attendanceUrl(settings, s),
      };
    }),
  };
}

async function studentAttendanceReport() {
  const [ctx, settings] = await Promise.all([loadWorkshopContext(), getSettings()]);
  const threshold = Number(settings.attendanceRequirementPercent) || 0;
  return {
    columns: [
      col("registrationId", "Registration ID"),
      col("fullName", "Student"),
      col("collegeName", "College"),
      col("course", "Course"),
      col("semesterYear", "Semester/Year"),
      col("totalSessions", "Total Sessions"),
      col("present", "Present"),
      col("absent", "Absent"),
      col("attendancePercent", "Attendance %"),
      col("meetsRequirement", `≥ ${threshold}%`),
    ],
    rows: ctx.students.map((s) => {
      const row = studentRow(ctx, s);
      return { ...row, meetsRequirement: ctx.heldSessions.length && row.attendancePercent >= threshold ? "Yes" : "No" };
    }),
  };
}

async function attendancePercentReport() {
  const ctx = await loadWorkshopContext();
  const bands = [
    { label: "90–100%", min: 90, max: 100.01 },
    { label: "75–89%", min: 75, max: 90 },
    { label: "50–74%", min: 50, max: 75 },
    { label: "25–49%", min: 25, max: 50 },
    { label: "0–24%", min: 0, max: 25 },
  ];
  const rows = ctx.students.map((s) => studentRow(ctx, s));
  return {
    columns: [col("band", "Attendance Band"), col("students", "Students"), col("share", "% of Students")],
    rows: bands.map((b) => {
      const n = rows.filter((r) => r.attendancePercent >= b.min && r.attendancePercent < b.max).length;
      return { band: b.label, students: n, share: percent(n, rows.length) };
    }),
  };
}

async function taskReport() {
  const tasks = await listTasks();
  return {
    columns: [
      col("title", "Task"),
      col("session", "Session"),
      col("deadline", "Deadline"),
      col("status", "Status"),
      col("completed", "Completed"),
      col("reviewed", "Reviewed"),
      col("pending", "Pending"),
      col("completionPercent", "Completion %"),
    ],
    rows: tasks.map((t) => ({
      _id: t._id,
      title: t.title,
      session: t.session ? `Day ${t.session.dayNumber}` : "",
      deadline: t.deadline,
      status: t.status,
      completed: t.counts.completed,
      reviewed: t.counts.Reviewed,
      pending: t.counts.pending,
      completionPercent: percent(t.counts.completed, t.counts.participants),
    })),
  };
}

async function whatsappReport() {
  const messages = await WorkshopWhatsappMessage.find().sort({ createdAt: -1 }).limit(500).lean();
  return {
    columns: [
      col("date", "Date"),
      col("kind", "Type"),
      col("title", "Title"),
      col("total", "Recipients"),
      col("accepted", "Accepted by API"),
      col("confirmedSent", "Sent (confirmed)"),
      col("delivered", "Delivered"),
      col("read", "Read"),
      col("failed", "Failed"),
      col("skipped", "Skipped"),
      col("status", "Status"),
    ],
    rows: messages.map((m) => {
      const s = summarizeMessage(m);
      return {
        _id: s._id,
        date: new Date(s.createdAt).toISOString().slice(0, 16).replace("T", " "),
        kind: s.kind,
        title: s.title || s.category || "",
        total: s.total,
        accepted: s.counts.accepted,
        confirmedSent: s.confirmedSent,
        delivered: s.counts.delivered,
        read: s.counts.read,
        failed: s.counts.failed,
        skipped: s.counts.skipped,
        status: s.status,
      };
    }),
  };
}

async function certificateReport() {
  const { rows, rules } = await getEligibility();
  return {
    columns: [
      col("registrationId", "Registration ID"),
      col("fullName", "Student"),
      col("collegeName", "College"),
      col("attendancePercent", "Attendance %"),
      col("tasksCompleted", "Tasks Completed"),
      col("eligibleLabel", `Eligible (≥ ${rules.threshold}%)`),
      col("reason", "Reason"),
      col("certificateNumber", "Certificate No."),
    ],
    rows: rows.map((r) => ({
      ...r,
      eligibleLabel: r.eligible ? "Yes" : "No",
      reason: r.reasons.join("; "),
      certificateNumber: r.certificate?.certificateNumber || "",
    })),
  };
}

export const REPORT_TYPES = {
  registrations: registrationReport,
  colleges: collegeReport,
  sessions: sessionReport,
  "student-attendance": studentAttendanceReport,
  "attendance-percentage": attendancePercentReport,
  tasks: taskReport,
  whatsapp: whatsappReport,
  certificates: certificateReport,
};

export async function getReport(type) {
  const fn = REPORT_TYPES[type];
  if (!fn) throw new HttpError(404, "Unknown report");
  return fn();
}
