import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { WorkshopRegistration } from "../workshop/workshop.model.js";
import {
  WorkshopSession,
  WorkshopAttendance,
  ATTENDANCE_STATUSES,
  ensureWorkshopIndexes,
} from "./workshopManagement.model.js";
import {
  HttpError,
  hitRateLimit,
  escapeRegex,
  formatDateLong,
  formatTimeRange,
  formatTime12,
  isValidDateString,
  todayIST,
} from "./workshopManagement.utils.js";
import { getSettings } from "./settings.service.js";
import {
  loadWorkshopContext,
  studentRow,
  sessionCell,
  sessionSummary,
  PARTICIPANT_FILTER,
} from "./stats.service.js";

const TOKEN_PURPOSE = "workshop-attendance";
const TOKEN_TTL = "10m";
const NOT_FOUND_MESSAGE =
  "We couldn't verify these details. Check your Registration ID / email and the last 4 digits of your registered mobile number.";

// ---------------------------------------------------------------------------
// Public flow
// ---------------------------------------------------------------------------

function attendanceWindow(session, settings, today) {
  if (!session.attendanceEnabled) return { open: false, reason: "Attendance is not enabled for this session yet." };
  if (session.status === "Cancelled") return { open: false, reason: "This session has been cancelled." };
  if (session.status === "Completed") return { open: false, reason: "Attendance for this session is closed." };
  if (settings.restrictAttendanceToSessionDate && session.date !== today) {
    return session.date > today
      ? { open: false, reason: `Attendance opens on ${formatDateLong(session.date)}.` }
      : { open: false, reason: "Attendance for this session is closed." };
  }
  return { open: true, reason: "" };
}

async function findPublicSession(slug) {
  const session = await WorkshopSession.findOne({ slug: String(slug || "").trim().toLowerCase() }).lean();
  if (!session) throw new HttpError(404, "This attendance link is not valid.");
  return session;
}

/** Only what the public page needs — no meeting link, no internal ids. */
export async function getPublicSession(slug) {
  const [session, settings] = await Promise.all([findPublicSession(slug), getSettings()]);
  const window = attendanceWindow(session, settings, todayIST());
  return {
    slug: session.slug,
    workshopName: settings.workshopName || "Skills Enhance Workshop",
    dayNumber: session.dayNumber,
    title: session.title,
    date: session.date,
    dateLabel: formatDateLong(session.date),
    timeLabel: formatTimeRange(session.startTime, session.endTime),
    attendanceOpen: window.open,
    closedReason: window.reason,
  };
}

async function findRegistrationByIdentifier(identifier) {
  const value = String(identifier || "").trim();
  if (!value || value.length > 120) return null;
  const query = value.includes("@")
    ? { email: value.toLowerCase() }
    : { registrationId: { $regex: `^${escapeRegex(value)}$`, $options: "i" } };
  return WorkshopRegistration.findOne({ ...query, ...PARTICIPANT_FILTER }).sort({ createdAt: -1 }).lean();
}

/**
 * Step 1: identifier (Registration ID or email) + last 4 digits of the
 * registered mobile. Returns minimal student details plus a short-lived token
 * that is the only thing /mark accepts — so knowing someone's Registration ID
 * alone is not enough to mark them present.
 */
export async function verifyStudent({ slug, identifier, mobileLast4 }) {
  const session = await findPublicSession(slug);
  const settings = await getSettings();
  const window = attendanceWindow(session, settings, todayIST());
  if (!window.open) throw new HttpError(403, window.reason);

  const last4 = String(mobileLast4 || "").replace(/\D/g, "");
  if (!String(identifier || "").trim() || last4.length !== 4) {
    throw new HttpError(400, "Enter your Registration ID or email, and the last 4 digits of your mobile number.");
  }

  // Per-identifier brute-force guard on the 4-digit check (on top of per-IP limits).
  const allowed = await hitRateLimit("wa-verify-id", String(identifier).trim().toLowerCase(), {
    limit: 6,
    windowSeconds: 15 * 60,
  });
  if (!allowed) throw new HttpError(429, "Too many attempts for this registration. Please try again in 15 minutes.");

  const registration = await findRegistrationByIdentifier(identifier);
  if (!registration || String(registration.mobile || "").slice(-4) !== last4) {
    throw new HttpError(404, NOT_FOUND_MESSAGE);
  }

  const existing = await WorkshopAttendance.findOne({
    sessionId: session._id,
    registrationId: registration.registrationId,
  }).lean();

  const token = jwt.sign(
    {
      purpose: TOKEN_PURPOSE,
      sid: String(session._id),
      rid: String(registration._id),
      method: String(identifier).includes("@") ? "email+mobile4" : "registrationId+mobile4",
    },
    env.jwtSecret,
    { expiresIn: TOKEN_TTL }
  );

  return {
    student: {
      fullName: registration.fullName,
      registrationId: registration.registrationId,
      collegeName: registration.collegeName,
      course: registration.course,
      semesterYear: registration.semesterYear,
    },
    alreadyMarked: Boolean(existing),
    existingStatus: existing?.status || null,
    markedAt: existing?.markedAt || null,
    token: existing ? null : token,
  };
}

/** Step 2: the student confirms; creates the attendance row exactly once. */
export async function markAttendance({ token }) {
  let decoded;
  try {
    decoded = jwt.verify(String(token || ""), env.jwtSecret);
  } catch {
    throw new HttpError(401, "Your verification has expired. Please find your details again.");
  }
  if (decoded.purpose !== TOKEN_PURPOSE || !decoded.sid || !decoded.rid) {
    throw new HttpError(401, "Invalid verification. Please find your details again.");
  }

  const [session, registration, settings] = await Promise.all([
    WorkshopSession.findById(decoded.sid).lean(),
    WorkshopRegistration.findOne({ _id: decoded.rid, ...PARTICIPANT_FILTER }).lean(),
    getSettings(),
  ]);
  if (!session || !registration) throw new HttpError(404, NOT_FOUND_MESSAGE);

  const window = attendanceWindow(session, settings, todayIST());
  if (!window.open) throw new HttpError(403, window.reason);

  const result = {
    student: { fullName: registration.fullName, registrationId: registration.registrationId },
    session: {
      dayNumber: session.dayNumber,
      title: session.title,
      dateLabel: formatDateLong(session.date),
    },
  };

  await ensureWorkshopIndexes();
  try {
    const row = await WorkshopAttendance.create({
      sessionId: session._id,
      registration: registration._id,
      registrationId: registration.registrationId,
      status: "Present",
      markedAt: new Date(),
      markedBy: "self",
      verificationMethod: decoded.method || "",
    });
    return {
      ...result,
      markedAt: row.markedAt,
      markedAtLabel: formatTime12(
        new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(row.markedAt)
      ),
    };
  } catch (err) {
    if (err?.code === 11000) {
      throw new HttpError(409, "You have already marked your attendance for this session.");
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export async function getSessionAttendance(sessionId) {
  if (!mongoose.isValidObjectId(sessionId)) return null;
  const session = await WorkshopSession.findById(sessionId).lean();
  if (!session) return null;

  const ctx = await loadWorkshopContext();
  const rows = ctx.students.map((student) => {
    const cell = sessionCell(ctx, student, session);
    return {
      _id: student._id,
      registrationId: student.registrationId,
      fullName: student.fullName,
      mobile: student.mobile,
      email: student.email,
      collegeName: student.collegeName,
      course: student.course,
      semesterYear: student.semesterYear,
      attendanceStatus: cell.status === "Upcoming" ? "Not Marked" : cell.status,
      attendanceId: cell.record?._id || null,
      markedAt: cell.record?.markedAt || null,
      markedBy: cell.record?.markedBy || "",
    };
  });

  return { session, summary: sessionSummary(ctx, session), rows };
}

/**
 * Manual correction by an admin. Every change appends to `history` with the
 * admin, timestamp, previous and new status.
 */
export async function setAttendanceStatus({ sessionId, registrationObjectId, status, note }, adminEmail) {
  if (!ATTENDANCE_STATUSES.includes(status)) throw new HttpError(400, "Status must be Present or Absent");
  if (!mongoose.isValidObjectId(sessionId) || !mongoose.isValidObjectId(registrationObjectId)) {
    throw new HttpError(400, "Invalid session or student");
  }

  const [session, registration] = await Promise.all([
    WorkshopSession.findById(sessionId).lean(),
    WorkshopRegistration.findById(registrationObjectId).lean(),
  ]);
  if (!session) throw new HttpError(404, "Session not found");
  if (!registration) throw new HttpError(404, "Student not found");

  await ensureWorkshopIndexes();
  const existing = await WorkshopAttendance.findOne({
    sessionId: session._id,
    registrationId: registration.registrationId,
  });

  const change = {
    admin: adminEmail,
    at: new Date(),
    previousStatus: existing?.status || "Not Marked",
    newStatus: status,
    note: String(note || "").trim().slice(0, 300),
  };

  if (existing) {
    if (existing.status === status) return existing.toObject();
    existing.status = status;
    existing.markedBy = adminEmail;
    existing.markedAt = new Date();
    existing.history.push(change);
    await existing.save();
    return existing.toObject();
  }

  const created = await WorkshopAttendance.create({
    sessionId: session._id,
    registration: registration._id,
    registrationId: registration.registrationId,
    status,
    markedAt: new Date(),
    markedBy: adminEmail,
    verificationMethod: "admin",
    history: [change],
  });
  return created.toObject();
}

export async function getAttendanceHistory(attendanceId) {
  if (!mongoose.isValidObjectId(attendanceId)) return null;
  return WorkshopAttendance.findById(attendanceId).lean();
}

/**
 * Attendance report. Optional scope by session or date narrows which sessions
 * are counted; the other filters narrow which students are listed.
 */
export async function getAttendanceReport(filters = {}) {
  const ctx = await loadWorkshopContext();
  const settings = await getSettings();
  const threshold = Number(settings.attendanceRequirementPercent) || 0;

  let scoped = ctx.heldSessions;
  if (filters.sessionId) scoped = scoped.filter((s) => String(s._id) === String(filters.sessionId));
  if (filters.date && isValidDateString(filters.date)) scoped = scoped.filter((s) => s.date === filters.date);
  const scopedCtx = { ...ctx, heldSessions: scoped };

  const rows = ctx.students
    .filter((s) => !filters.college || s.collegeName === filters.college)
    .filter((s) => !filters.course || s.course === filters.course)
    .filter((s) => !filters.semesterYear || s.semesterYear === filters.semesterYear)
    .map((s) => studentRow(scopedCtx, s))
    .filter((row) => {
      switch (filters.attendanceStatus) {
        case "Present":
          return row.present > 0 && row.absent === 0;
        case "Absent":
          return row.absent > 0;
        case "Eligible":
          return row.attendancePercent >= threshold;
        case "Below":
          return row.attendancePercent < threshold;
        default:
          return true;
      }
    });

  return {
    threshold,
    sessionsCounted: scoped.length,
    sessions: ctx.sessions.map((s) => ({ _id: s._id, dayNumber: s.dayNumber, title: s.title, date: s.date })),
    rows,
  };
}

/** Student × session matrix for the "Student Attendance" view. */
export async function getAttendanceMatrix() {
  const ctx = await loadWorkshopContext();
  return {
    sessions: ctx.sessions.map((s) => ({ _id: s._id, dayNumber: s.dayNumber, title: s.title, date: s.date, status: s.status })),
    rows: ctx.students.map((student) => ({
      ...studentRow(ctx, student),
      cells: ctx.sessions.map((session) => sessionCell(ctx, student, session).status),
    })),
  };
}
