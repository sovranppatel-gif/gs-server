import { env } from "../../config/env.js";
import { verifyWebhookSignature } from "../../lib/whatsappCloud.js";
import { sendError, adminEmail } from "./workshopManagement.utils.js";
import * as sessions from "./sessions.service.js";
import * as attendance from "./attendance.service.js";
import * as students from "./students.service.js";
import * as tasks from "./tasks.service.js";
import * as whatsapp from "./whatsapp.service.js";
import * as certificates from "./certificates.service.js";
import * as settings from "./settings.service.js";
import * as reports from "./reports.service.js";

/**
 * Wraps a service call in the module's standard JSON envelope.
 * `key` is the response field ("entry" / "rows" / "data"); a null result
 * becomes a 404 with `notFound`.
 */
function handle(fn, { key = "data", status = 200, notFound = "Not found", errorMessage = "Request failed", tag = "request" } = {}) {
  return async (req, res) => {
    try {
      const result = await fn(req);
      if (result === null || result === undefined) {
        return res.status(404).json({ success: false, message: notFound });
      }
      return res.status(status).json({ success: true, [key]: result });
    } catch (err) {
      return sendError(res, err, errorMessage, tag);
    }
  };
}

// Sessions -------------------------------------------------------------------
export const getPublicSession = handle((req) => attendance.getPublicSession(req.params.slug), { key: "entry", tag: "public session" });
export const listSessions = handle(() => sessions.listSessions(), { key: "rows", tag: "list sessions" });
export const getSession = handle((req) => sessions.getSession(req.params.id), { key: "entry", notFound: "Session not found" });
export const createSession = handle((req) => sessions.createSession(req.body || {}, adminEmail(req)), {
  key: "entry",
  status: 201,
  errorMessage: "Failed to create session",
  tag: "create session",
});
export const updateSession = handle((req) => sessions.updateSession(req.params.id, req.body || {}), {
  key: "entry",
  notFound: "Session not found",
  errorMessage: "Failed to update session",
  tag: "update session",
});
export const deleteSession = handle(
  async (req) => ((await sessions.deleteSession(req.params.id)) ? { deleted: true } : null),
  { notFound: "Session not found", errorMessage: "Failed to delete session", tag: "delete session" }
);

// Attendance -----------------------------------------------------------------
export const verifyAttendance = handle((req) => attendance.verifyStudent(req.body || {}), { key: "entry", tag: "verify attendance" });
export const markAttendance = handle((req) => attendance.markAttendance(req.body || {}), {
  key: "entry",
  status: 201,
  errorMessage: "Failed to mark attendance",
  tag: "mark attendance",
});
export const getSessionAttendance = handle((req) => attendance.getSessionAttendance(req.params.sessionId), {
  notFound: "Session not found",
  tag: "session attendance",
});
export const setAttendance = handle(
  (req) =>
    attendance.setAttendanceStatus(
      {
        sessionId: req.params.sessionId,
        registrationObjectId: req.params.studentId,
        status: req.body?.status,
        note: req.body?.note,
      },
      adminEmail(req)
    ),
  { key: "entry", errorMessage: "Failed to update attendance", tag: "set attendance" }
);
export const getAttendanceRecord = handle((req) => attendance.getAttendanceHistory(req.params.id), {
  key: "entry",
  notFound: "Attendance record not found",
});
export const getAttendanceReport = handle(
  (req) =>
    attendance.getAttendanceReport({
      sessionId: req.query.sessionId || "",
      date: req.query.date || "",
      college: req.query.college || "",
      course: req.query.course || "",
      semesterYear: req.query.semesterYear || "",
      attendanceStatus: req.query.attendanceStatus || "",
    }),
  { tag: "attendance report" }
);
export const getAttendanceMatrix = handle(() => attendance.getAttendanceMatrix(), { tag: "attendance matrix" });

// Students -------------------------------------------------------------------
export const listStudents = handle(() => students.listStudents(), { tag: "list students" });
export const getStudent = handle((req) => students.getStudentProfile(req.params.id), { notFound: "Student not found", tag: "student profile" });
export const getStudentAttendance = handle(
  async (req) => {
    const profile = await students.getStudentProfile(req.params.id);
    return profile ? { student: profile.student, attendance: profile.attendance } : null;
  },
  { notFound: "Student not found", tag: "student attendance" }
);

// Tasks ----------------------------------------------------------------------
export const listTasks = handle(() => tasks.listTasks(), { key: "rows", tag: "list tasks" });
export const createTask = handle((req) => tasks.createTask(req.body || {}, adminEmail(req)), { key: "entry", status: 201, tag: "create task" });
export const updateTask = handle((req) => tasks.updateTask(req.params.id, req.body || {}), { key: "entry", notFound: "Task not found", tag: "update task" });
export const deleteTask = handle(async (req) => ((await tasks.deleteTask(req.params.id)) ? { deleted: true } : null), {
  notFound: "Task not found",
  tag: "delete task",
});
export const getTaskSubmissions = handle((req) => tasks.getTaskSubmissions(req.params.id), { notFound: "Task not found", tag: "task submissions" });
export const reviewSubmission = handle((req) => tasks.reviewSubmission(req.params.submissionId, req.body || {}, adminEmail(req)), {
  key: "entry",
  notFound: "Submission not found",
  tag: "review submission",
});
export const adminRecordSubmission = handle(
  (req) => tasks.adminRecordSubmission(req.params.id, req.params.studentId, req.body?.content, adminEmail(req)),
  { key: "entry", tag: "record submission" }
);
export const getPublicTask = handle((req) => tasks.getPublicTask(req.params.id), { key: "entry", tag: "public task" });
export const verifyForTask = handle((req) => tasks.verifyForTask(req.params.id, req.body || {}), { key: "entry", tag: "verify task" });
export const submitTask = handle((req) => tasks.submitTask(req.body || {}), { key: "entry", status: 201, tag: "submit task" });

// WhatsApp -------------------------------------------------------------------
export const whatsappStatus = handle(() => whatsapp.getWhatsappStatus(), { tag: "whatsapp status" });
export const whatsappPreview = handle((req) => whatsapp.previewAudience(req.body || {}), { tag: "whatsapp preview" });
export const createWhatsappMessage = handle((req) => whatsapp.createMessage(req.body || {}, adminEmail(req)), {
  key: "entry",
  status: 201,
  errorMessage: "Failed to create message",
  tag: "create whatsapp",
});
export const processWhatsappMessage = handle((req) => whatsapp.processMessage(req.params.id, Number(req.body?.batchSize) || 20), {
  key: "entry",
  notFound: "Message not found",
  errorMessage: "Failed to send messages",
  tag: "process whatsapp",
});
export const listWhatsappMessages = handle((req) => whatsapp.listMessages({ kind: req.query.kind || "" }), { key: "rows", tag: "list whatsapp" });
export const getWhatsappMessage = handle((req) => whatsapp.getMessage(req.params.id), { key: "entry", notFound: "Message not found" });

/** Meta webhook verification handshake (GET). */
export function whatsappWebhookVerify(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && env.whatsappWebhookVerifyToken && token === env.whatsappWebhookVerifyToken) {
    return res.status(200).send(String(challenge || ""));
  }
  return res.sendStatus(403);
}

/** Meta delivery status callbacks (POST). Always 200 so Meta doesn't retry-storm. */
export async function whatsappWebhookReceive(req, res) {
  if (!verifyWebhookSignature(req.rawBody, req.headers["x-hub-signature-256"])) {
    return res.sendStatus(401);
  }
  try {
    await whatsapp.applyStatusUpdates(req.body);
  } catch (err) {
    console.error("[workshop-mgmt] webhook error:", err);
  }
  return res.sendStatus(200);
}

// Certificates -----------------------------------------------------------------
export const certificateEligibility = handle(() => certificates.getEligibility(), { tag: "certificate eligibility" });
export const issueCertificates = handle((req) => certificates.issueCertificates(req.body?.studentIds, adminEmail(req)), { tag: "issue certificates" });
export const updateCertificate = handle((req) => certificates.setCertificateStatus(req.params.id, req.body?.status), {
  key: "entry",
  notFound: "Certificate not found",
});
export const getCertificate = handle((req) => certificates.getCertificate(req.params.id), { key: "entry", notFound: "Certificate not found" });

// Settings -------------------------------------------------------------------
export const getSettings = handle(() => settings.getSettings(), { key: "entry", tag: "get settings" });
export const updateSettings = handle((req) => settings.updateSettings(req.body || {}, adminEmail(req)), {
  key: "entry",
  errorMessage: "Failed to save settings",
  tag: "update settings",
});

// Dashboard & reports ----------------------------------------------------------
export const getDashboard = handle(() => reports.getDashboard(), { tag: "dashboard" });
export const getReport = handle((req) => reports.getReport(req.params.type), { tag: "report" });
