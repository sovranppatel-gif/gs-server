import { Router } from "express";
import { requireMasterAdminJwt } from "../../middleware/requireMasterAdminJwt.js";
import { rateLimitMiddleware } from "./workshopManagement.utils.js";
import * as c from "./workshopManagement.controller.js";

/*
 * Public routes (no JWT) are declared first in each router and are each
 * rate-limited per IP. Everything else requires the master-admin JWT.
 */

const publicRead = rateLimitMiddleware("wm-public-read", { limit: 120, windowSeconds: 60 });
const publicVerify = rateLimitMiddleware("wm-public-verify", { limit: 20, windowSeconds: 10 * 60 });
const publicWrite = rateLimitMiddleware("wm-public-write", { limit: 20, windowSeconds: 10 * 60 });

// /api/workshop-sessions
export const sessionsRouter = Router();
sessionsRouter.get("/public/:slug", publicRead, c.getPublicSession);
sessionsRouter.get("/", requireMasterAdminJwt, c.listSessions);
sessionsRouter.post("/", requireMasterAdminJwt, c.createSession);
sessionsRouter.get("/:id", requireMasterAdminJwt, c.getSession);
sessionsRouter.patch("/:id", requireMasterAdminJwt, c.updateSession);
sessionsRouter.delete("/:id", requireMasterAdminJwt, c.deleteSession);

// /api/workshop-attendance
export const attendanceRouter = Router();
attendanceRouter.post("/verify", publicVerify, c.verifyAttendance);
attendanceRouter.post("/mark", publicWrite, c.markAttendance);
// static admin paths before /:sessionId
attendanceRouter.get("/report", requireMasterAdminJwt, c.getAttendanceReport);
attendanceRouter.get("/matrix", requireMasterAdminJwt, c.getAttendanceMatrix);
attendanceRouter.get("/record/:id", requireMasterAdminJwt, c.getAttendanceRecord);
attendanceRouter.put("/:sessionId/students/:studentId", requireMasterAdminJwt, c.setAttendance);
attendanceRouter.get("/:sessionId", requireMasterAdminJwt, c.getSessionAttendance);

// /api/workshop-students  (read-only view over existing registrations)
export const studentsRouter = Router();
studentsRouter.get("/", requireMasterAdminJwt, c.listStudents);
studentsRouter.get("/:id/attendance", requireMasterAdminJwt, c.getStudentAttendance);
studentsRouter.get("/:id", requireMasterAdminJwt, c.getStudent);

// /api/workshop-tasks
export const tasksRouter = Router();
tasksRouter.get("/public/:id", publicRead, c.getPublicTask);
tasksRouter.post("/public/:id/verify", publicVerify, c.verifyForTask);
tasksRouter.post("/public/submit", publicWrite, c.submitTask);
tasksRouter.get("/", requireMasterAdminJwt, c.listTasks);
tasksRouter.post("/", requireMasterAdminJwt, c.createTask);
tasksRouter.patch("/submissions/:submissionId", requireMasterAdminJwt, c.reviewSubmission);
tasksRouter.get("/:id/submissions", requireMasterAdminJwt, c.getTaskSubmissions);
tasksRouter.put("/:id/submissions/:studentId", requireMasterAdminJwt, c.adminRecordSubmission);
tasksRouter.patch("/:id", requireMasterAdminJwt, c.updateTask);
tasksRouter.delete("/:id", requireMasterAdminJwt, c.deleteTask);

// /api/workshop-whatsapp
export const whatsappRouter = Router();
whatsappRouter.get("/webhook", c.whatsappWebhookVerify);
whatsappRouter.post("/webhook", c.whatsappWebhookReceive);
whatsappRouter.get("/status", requireMasterAdminJwt, c.whatsappStatus);
whatsappRouter.post("/preview", requireMasterAdminJwt, c.whatsappPreview);
whatsappRouter.get("/messages", requireMasterAdminJwt, c.listWhatsappMessages);
whatsappRouter.post("/messages", requireMasterAdminJwt, c.createWhatsappMessage);
whatsappRouter.get("/messages/:id", requireMasterAdminJwt, c.getWhatsappMessage);
whatsappRouter.post("/messages/:id/process", requireMasterAdminJwt, c.processWhatsappMessage);

// /api/workshop-certificates
export const certificatesRouter = Router();
certificatesRouter.get("/", requireMasterAdminJwt, c.certificateEligibility);
certificatesRouter.post("/issue", requireMasterAdminJwt, c.issueCertificates);
certificatesRouter.get("/:id", requireMasterAdminJwt, c.getCertificate);
certificatesRouter.patch("/:id", requireMasterAdminJwt, c.updateCertificate);

// /api/workshop-settings
export const settingsRouter = Router();
settingsRouter.get("/", requireMasterAdminJwt, c.getSettings);
settingsRouter.put("/", requireMasterAdminJwt, c.updateSettings);

// /api/workshop-reports
export const reportsRouter = Router();
reportsRouter.get("/dashboard", requireMasterAdminJwt, c.getDashboard);
reportsRouter.get("/:type", requireMasterAdminJwt, c.getReport);
