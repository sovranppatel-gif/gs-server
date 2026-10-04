import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { WorkshopRegistration } from "../workshop/workshop.model.js";
import {
  WorkshopTask,
  WorkshopTaskSubmission,
  WorkshopSession,
  TASK_STATUSES,
  TASK_SUBMISSION_TYPES,
  SUBMISSION_STATUSES,
  ensureWorkshopIndexes,
} from "./workshopManagement.model.js";
import { HttpError, hitRateLimit, escapeRegex, isValidDateString, todayIST } from "./workshopManagement.utils.js";
import { PARTICIPANT_FILTER } from "./stats.service.js";

const TOKEN_PURPOSE = "workshop-task";

function cleanTask(raw = {}, { partial = false } = {}) {
  const out = {};
  const has = (k) => raw[k] !== undefined;
  if (!partial || has("title")) {
    out.title = String(raw.title || "").trim();
    if (!out.title) throw new HttpError(400, "Task title is required");
  }
  if (!partial || has("description")) out.description = String(raw.description || "").trim();
  if (!partial || has("sessionId")) {
    out.sessionId = raw.sessionId && mongoose.isValidObjectId(raw.sessionId) ? raw.sessionId : null;
  }
  if (!partial || has("deadline")) {
    out.deadline = String(raw.deadline || "").trim();
    if (out.deadline && !isValidDateString(out.deadline)) throw new HttpError(400, "Deadline must be a valid date");
  }
  if (!partial || has("submissionType")) {
    out.submissionType = raw.submissionType || "URL";
    if (!TASK_SUBMISSION_TYPES.includes(out.submissionType)) throw new HttpError(400, "Invalid submission type");
  }
  if (!partial || has("status")) {
    out.status = raw.status || "Active";
    if (!TASK_STATUSES.includes(out.status)) throw new HttpError(400, "Invalid task status");
  }
  return out;
}

export async function listTasks() {
  const [tasks, counts, participants] = await Promise.all([
    WorkshopTask.find().sort({ createdAt: -1 }).populate("sessionId", "dayNumber title").lean(),
    WorkshopTaskSubmission.aggregate([{ $group: { _id: { taskId: "$taskId", status: "$status" }, n: { $sum: 1 } } }]),
    WorkshopRegistration.countDocuments(PARTICIPANT_FILTER),
  ]);
  const byTask = new Map();
  for (const c of counts) {
    const key = String(c._id.taskId);
    if (!byTask.has(key)) byTask.set(key, { Submitted: 0, Reviewed: 0, Rejected: 0 });
    byTask.get(key)[c._id.status] = c.n;
  }
  return tasks.map((task) => {
    const c = byTask.get(String(task._id)) || { Submitted: 0, Reviewed: 0, Rejected: 0 };
    const completed = c.Submitted + c.Reviewed;
    return {
      ...task,
      session: task.sessionId || null,
      sessionId: task.sessionId?._id || null,
      counts: { ...c, completed, pending: Math.max(0, participants - completed), participants },
    };
  });
}

export async function createTask(raw, adminEmail) {
  const task = await WorkshopTask.create({ ...cleanTask(raw), createdBy: adminEmail });
  return task.toObject();
}

export async function updateTask(id, raw) {
  if (!mongoose.isValidObjectId(id)) return null;
  return WorkshopTask.findByIdAndUpdate(id, { $set: cleanTask(raw, { partial: true }) }, { returnDocument: "after", runValidators: true }).lean();
}

export async function deleteTask(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const count = await WorkshopTaskSubmission.countDocuments({ taskId: id });
  if (count > 0) {
    throw new HttpError(409, `This task has ${count} submission(s). Set its status to Closed instead of deleting it.`);
  }
  return WorkshopTask.findByIdAndDelete(id).lean();
}

/** All participants with their submission (or Pending) for one task. */
export async function getTaskSubmissions(taskId) {
  if (!mongoose.isValidObjectId(taskId)) return null;
  const task = await WorkshopTask.findById(taskId).lean();
  if (!task) return null;
  const [students, submissions] = await Promise.all([
    WorkshopRegistration.find(PARTICIPANT_FILTER, { registrationId: 1, fullName: 1, collegeName: 1, course: 1, mobile: 1 })
      .sort({ registrationId: 1 })
      .lean(),
    WorkshopTaskSubmission.find({ taskId }).lean(),
  ]);
  const byReg = new Map(submissions.map((s) => [s.registrationId, s]));
  return {
    task,
    rows: students.map((s) => {
      const sub = byReg.get(s.registrationId);
      return {
        _id: s._id,
        registrationId: s.registrationId,
        fullName: s.fullName,
        collegeName: s.collegeName,
        course: s.course,
        submissionId: sub?._id || null,
        submissionStatus: sub ? sub.status : "Pending",
        content: sub?.content || "",
        reviewNote: sub?.reviewNote || "",
        submittedAt: sub?.createdAt || null,
      };
    }),
  };
}

export async function reviewSubmission(submissionId, { status, reviewNote }, adminEmail) {
  if (!mongoose.isValidObjectId(submissionId)) return null;
  if (!SUBMISSION_STATUSES.includes(status)) throw new HttpError(400, "Invalid submission status");
  return WorkshopTaskSubmission.findByIdAndUpdate(
    submissionId,
    {
      $set: {
        status,
        reviewNote: String(reviewNote || "").trim().slice(0, 500),
        reviewedBy: adminEmail,
        reviewedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  ).lean();
}

/** Admin records a submission on a student's behalf (e.g. shared over WhatsApp). */
export async function adminRecordSubmission(taskId, registrationObjectId, content, adminEmail) {
  if (!mongoose.isValidObjectId(taskId) || !mongoose.isValidObjectId(registrationObjectId)) {
    throw new HttpError(400, "Invalid task or student");
  }
  const registration = await WorkshopRegistration.findById(registrationObjectId).lean();
  if (!registration) throw new HttpError(404, "Student not found");
  return WorkshopTaskSubmission.findOneAndUpdate(
    { taskId, registrationId: registration.registrationId },
    {
      $set: { content: String(content || "").trim().slice(0, 1000), status: "Reviewed", reviewedBy: adminEmail, reviewedAt: new Date() },
      $setOnInsert: { registration: registration._id, submittedBy: adminEmail },
    },
    { upsert: true, returnDocument: "after" }
  ).lean();
}

// ---------------------------------------------------------------------------
// Public submission (same verification as attendance)
// ---------------------------------------------------------------------------

function taskOpen(task) {
  if (task.status !== "Active") return { open: false, reason: "This task is not accepting submissions." };
  if (task.deadline && todayIST() > task.deadline) return { open: false, reason: "The deadline for this task has passed." };
  return { open: true, reason: "" };
}

export async function getPublicTask(id) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, "Task not found");
  const task = await WorkshopTask.findById(id).lean();
  if (!task || task.status === "Draft") throw new HttpError(404, "Task not found");
  const session = task.sessionId ? await WorkshopSession.findById(task.sessionId, { dayNumber: 1, title: 1 }).lean() : null;
  const state = taskOpen(task);
  return {
    _id: task._id,
    title: task.title,
    description: task.description,
    deadline: task.deadline,
    submissionType: task.submissionType,
    session: session ? { dayNumber: session.dayNumber, title: session.title } : null,
    open: state.open,
    closedReason: state.reason,
  };
}

export async function verifyForTask(taskId, { identifier, mobileLast4 }) {
  const task = await getPublicTask(taskId);
  if (!task.open) throw new HttpError(403, task.closedReason);
  const value = String(identifier || "").trim();
  const last4 = String(mobileLast4 || "").replace(/\D/g, "");
  if (!value || value.length > 120 || last4.length !== 4) {
    throw new HttpError(400, "Enter your Registration ID or email, and the last 4 digits of your mobile number.");
  }
  const allowed = await hitRateLimit("task-verify-id", value.toLowerCase(), { limit: 6, windowSeconds: 15 * 60 });
  if (!allowed) throw new HttpError(429, "Too many attempts. Please try again in 15 minutes.");

  const query = value.includes("@")
    ? { email: value.toLowerCase() }
    : { registrationId: { $regex: `^${escapeRegex(value)}$`, $options: "i" } };
  const registration = await WorkshopRegistration.findOne({ ...query, ...PARTICIPANT_FILTER }).lean();
  if (!registration || String(registration.mobile || "").slice(-4) !== last4) {
    throw new HttpError(404, "We couldn't verify these details.");
  }
  const existing = await WorkshopTaskSubmission.findOne({ taskId, registrationId: registration.registrationId }).lean();
  const token = jwt.sign({ purpose: TOKEN_PURPOSE, tid: String(taskId), rid: String(registration._id) }, env.jwtSecret, {
    expiresIn: "15m",
  });
  return {
    student: { fullName: registration.fullName, registrationId: registration.registrationId },
    existing: existing ? { content: existing.content, status: existing.status } : null,
    token,
  };
}

function validateContent(type, content) {
  const value = String(content || "").trim();
  if (type === "None") return "";
  if (!value) throw new HttpError(400, "Please enter your submission");
  if (value.length > 1000) throw new HttpError(400, "Submission is too long");
  if (type !== "Text" && !/^https?:\/\/\S+$/i.test(value)) throw new HttpError(400, "Please enter a valid link starting with https://");
  if (type === "GitHub URL" && !/github\.com/i.test(value)) throw new HttpError(400, "Please enter your GitHub link");
  if (type === "LinkedIn URL" && !/linkedin\.com/i.test(value)) throw new HttpError(400, "Please enter your LinkedIn link");
  return value;
}

export async function submitTask({ token, content }) {
  let decoded;
  try {
    decoded = jwt.verify(String(token || ""), env.jwtSecret);
  } catch {
    throw new HttpError(401, "Your verification has expired. Please verify again.");
  }
  if (decoded.purpose !== TOKEN_PURPOSE) throw new HttpError(401, "Invalid verification");
  const task = await WorkshopTask.findById(decoded.tid).lean();
  if (!task) throw new HttpError(404, "Task not found");
  const state = taskOpen(task);
  if (!state.open) throw new HttpError(403, state.reason);
  const registration = await WorkshopRegistration.findOne({ _id: decoded.rid, ...PARTICIPANT_FILTER }).lean();
  if (!registration) throw new HttpError(404, "Student not found");

  const existing = await WorkshopTaskSubmission.findOne({ taskId: task._id, registrationId: registration.registrationId }).lean();
  if (existing?.status === "Reviewed") throw new HttpError(409, "Your submission has already been reviewed.");

  const value = validateContent(task.submissionType, content);
  await ensureWorkshopIndexes();
  return WorkshopTaskSubmission.findOneAndUpdate(
    { taskId: task._id, registrationId: registration.registrationId },
    {
      $set: { content: value, status: "Submitted", submittedBy: "self" },
      $setOnInsert: { registration: registration._id },
    },
    { upsert: true, returnDocument: "after" }
  ).lean();
}
