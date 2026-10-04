import mongoose from "mongoose";
import { WorkshopRegistration } from "../workshop/workshop.model.js";
import {
  WorkshopTask,
  WorkshopTaskSubmission,
  WorkshopWhatsappMessage,
  WorkshopCertificate,
} from "./workshopManagement.model.js";
import { loadWorkshopContext, studentRow, sessionCell } from "./stats.service.js";
import { getSettings } from "./settings.service.js";

/**
 * Students = the existing workshop registrations, read-only. Rejected
 * registrations are listed too (so the Status filter still works) but they
 * are not counted in attendance totals.
 */
export async function listStudents() {
  const [ctx, rejected, settings] = await Promise.all([
    loadWorkshopContext({ withTasks: true }),
    WorkshopRegistration.find({ status: "Rejected" }).sort({ createdAt: -1 }).lean(),
    getSettings(),
  ]);
  const rows = [...ctx.students, ...rejected].map((s) => studentRow(ctx, s));
  rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return {
    rows,
    sessionsCounted: ctx.heldSessions.length,
    threshold: Number(settings.attendanceRequirementPercent) || 0,
  };
}

export async function getStudentProfile(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const student = await WorkshopRegistration.findById(id).lean();
  if (!student) return null;

  const [ctx, tasks, submissions, messages, certificate] = await Promise.all([
    loadWorkshopContext({ withTasks: true }),
    WorkshopTask.find({ status: { $ne: "Draft" } }).sort({ createdAt: 1 }).lean(),
    WorkshopTaskSubmission.find({ registrationId: student.registrationId }).lean(),
    WorkshopWhatsappMessage.find(
      { "recipients.registrationId": student.registrationId },
      { kind: 1, title: 1, category: 1, createdAt: 1, createdBy: 1, "recipients.$": 1 }
    )
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
    WorkshopCertificate.findOne({ registrationId: student.registrationId }).lean(),
  ]);

  const submissionByTask = new Map(submissions.map((s) => [String(s.taskId), s]));

  return {
    student: studentRow(ctx, student),
    referralCode: student.referralCode,
    attendance: ctx.sessions.map((session) => {
      const cell = sessionCell(ctx, student, session);
      return {
        sessionId: session._id,
        dayNumber: session.dayNumber,
        title: session.title,
        date: session.date,
        status: cell.status,
        markedAt: cell.record?.markedAt || null,
        markedBy: cell.record?.markedBy || "",
        attendanceId: cell.record?._id || null,
      };
    }),
    tasks: tasks.map((task) => {
      const sub = submissionByTask.get(String(task._id));
      return {
        taskId: task._id,
        title: task.title,
        deadline: task.deadline,
        status: sub ? sub.status : "Pending",
        content: sub?.content || "",
        submittedAt: sub?.createdAt || null,
      };
    }),
    whatsapp: messages.map((m) => ({
      _id: m._id,
      kind: m.kind,
      title: m.title || m.category || (m.kind === "announcement" ? "Announcement" : "Reminder"),
      createdAt: m.createdAt,
      status: m.recipients?.[0]?.status || "",
      error: m.recipients?.[0]?.error || "",
      text: m.recipients?.[0]?.renderedText || "",
    })),
    certificate,
  };
}
