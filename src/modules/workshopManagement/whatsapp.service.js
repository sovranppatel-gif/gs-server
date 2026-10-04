import mongoose from "mongoose";
import { WorkshopSession, WorkshopWhatsappMessage } from "./workshopManagement.model.js";
import {
  isWhatsappConfigured,
  whatsappConfigStatus,
  sendWhatsappText,
  sendWhatsappTemplate,
} from "../../lib/whatsappCloud.js";
import { HttpError, formatDateLong, formatTimeRange, toWhatsappNumber } from "./workshopManagement.utils.js";
import { getSettings, attendanceUrl } from "./settings.service.js";
import { loadWorkshopContext, studentAttendanceStats, sessionCell, pickTodaySession } from "./stats.service.js";

export const MESSAGE_VARIABLES = [
  "name",
  "registrationId",
  "college",
  "sessionTitle",
  "day",
  "date",
  "time",
  "attendanceLink",
];

export const AUDIENCE_TYPES = [
  "all",
  "college",
  "session_present",
  "session_absent",
  "today_absent",
  "low_attendance",
  "selected",
];

const STATUS_RANK = { queued: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };

export function renderMessage(body, vars) {
  return String(body || "").replace(/{{\s*(\w+)\s*}}/g, (match, key) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : match
  );
}

function buildVars(student, session, settings) {
  return {
    name: student.fullName,
    registrationId: student.registrationId,
    college: student.collegeName || "",
    sessionTitle: session?.title || "",
    day: session ? `Day ${session.dayNumber}` : "",
    date: session ? formatDateLong(session.date) : "",
    time: session ? formatTimeRange(session.startTime, session.endTime) : "",
    attendanceLink: session ? attendanceUrl(settings, session) : "",
  };
}

async function resolveAudience(audience = {}, ctx, settings) {
  const type = AUDIENCE_TYPES.includes(audience.type) ? audience.type : "all";
  let sessionForAudience = null;

  if (type === "session_present" || type === "session_absent") {
    sessionForAudience = ctx.sessions.find((s) => String(s._id) === String(audience.sessionId));
    if (!sessionForAudience) throw new HttpError(400, "Select a session for this audience");
  }
  if (type === "today_absent") {
    sessionForAudience = pickTodaySession(ctx);
    if (!sessionForAudience) throw new HttpError(400, "There is no session scheduled for today");
  }

  const threshold = Number(audience.threshold ?? settings.attendanceRequirementPercent) || 0;
  const selected = new Set((audience.studentIds || []).map(String));

  const students = ctx.students.filter((student) => {
    switch (type) {
      case "college":
        return student.collegeName === audience.college;
      case "session_present":
        return sessionCell(ctx, student, sessionForAudience).status === "Present";
      case "session_absent":
      case "today_absent":
        return sessionCell(ctx, student, sessionForAudience).status !== "Present";
      case "low_attendance":
        return ctx.heldSessions.length > 0 && studentAttendanceStats(ctx, student).attendancePercent < threshold;
      case "selected":
        return selected.has(String(student._id));
      default:
        return true;
    }
  });

  return { type, students, sessionForAudience };
}

async function loadSession(sessionId) {
  if (!sessionId || !mongoose.isValidObjectId(sessionId)) return null;
  return WorkshopSession.findById(sessionId).lean();
}

export async function getWhatsappStatus() {
  const settings = await getSettings();
  return {
    ...whatsappConfigStatus(),
    enabled: Boolean(settings.whatsapp?.enabled),
    sendMode: settings.whatsapp?.sendMode || "template",
    templateName: settings.whatsapp?.templateName || "",
    templateParams: settings.whatsapp?.templateParams || [],
    variables: MESSAGE_VARIABLES,
    messageTemplates: settings.messageTemplates || [],
  };
}

export async function previewAudience({ audience, sessionId, body }) {
  const [ctx, settings] = await Promise.all([loadWorkshopContext(), getSettings()]);
  const { students, sessionForAudience } = await resolveAudience(audience, ctx, settings);
  const session = (await loadSession(sessionId)) || sessionForAudience;
  const withPhone = students.filter((s) => toWhatsappNumber(s.whatsappNumber || s.mobile));
  const sample = students[0];
  return {
    total: students.length,
    withPhone: withPhone.length,
    withoutPhone: students.length - withPhone.length,
    sampleText: sample ? renderMessage(body, buildVars(sample, session, settings)) : "",
    sampleName: sample?.fullName || "",
    recipients: students.slice(0, 500).map((s) => ({ _id: s._id, registrationId: s.registrationId, fullName: s.fullName, collegeName: s.collegeName })),
  };
}

/**
 * Creates the message with every recipient "queued". Sending happens in
 * small batches via processMessage() so each HTTP request stays well under
 * the serverless time limit.
 */
export async function createMessage(payload, adminEmail) {
  const body = String(payload.body || "").trim();
  if (!body) throw new HttpError(400, "Message text is required");
  if (body.length > 4000) throw new HttpError(400, "Message is too long");

  const settings = await getSettings();
  if (!isWhatsappConfigured()) {
    throw new HttpError(400, "WhatsApp Cloud API is not configured on the server (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID).");
  }
  if (!settings.whatsapp?.enabled) throw new HttpError(400, "WhatsApp sending is turned off in Workshop Settings.");
  if (settings.whatsapp.sendMode === "template" && !settings.whatsapp.templateName) {
    throw new HttpError(400, "Set an approved WhatsApp template name in Workshop Settings first.");
  }

  const ctx = await loadWorkshopContext();
  const { students, sessionForAudience } = await resolveAudience(payload.audience, ctx, settings);
  if (!students.length) throw new HttpError(400, "No students match the selected recipients");

  const session = (await loadSession(payload.sessionId)) || sessionForAudience;

  const templateKeys = settings.whatsapp.sendMode === "template" ? settings.whatsapp.templateParams || [] : [];
  const recipients = students.map((student) => {
    const phone = toWhatsappNumber(student.whatsappNumber || student.mobile);
    const vars = buildVars(student, session, settings);
    return {
      registration: student._id,
      registrationId: student.registrationId,
      name: student.fullName,
      phone,
      renderedText: renderMessage(body, vars),
      params: templateKeys.map((key) => String(vars[key] ?? "")),
      status: phone ? "queued" : "skipped",
      error: phone ? "" : "No valid mobile number",
      updatedAt: new Date(),
    };
  });

  const message = await WorkshopWhatsappMessage.create({
    kind: payload.kind === "announcement" ? "announcement" : "reminder",
    category: String(payload.category || "").trim(),
    title: String(payload.title || "").trim(),
    body,
    audience: { ...(payload.audience || {}), studentIds: undefined, selectedCount: payload.audience?.studentIds?.length || undefined },
    sessionId: session?._id || null,
    recipients,
    status: "queued",
    createdBy: adminEmail,
  });

  return summarizeMessage(message.toObject());
}

export async function processMessage(id, batchSize = 20) {
  if (!mongoose.isValidObjectId(id)) return null;
  const message = await WorkshopWhatsappMessage.findById(id);
  if (!message) return null;
  if (!isWhatsappConfigured()) throw new HttpError(400, "WhatsApp Cloud API is not configured on the server.");

  const settings = await getSettings();
  const wa = settings.whatsapp || {};

  const pending = message.recipients.filter((r) => r.status === "queued").slice(0, Math.min(Math.max(batchSize, 1), 40));
  message.status = "processing";

  for (const recipient of pending) {
    let result;
    if (wa.sendMode === "text") {
      result = await sendWhatsappText(recipient.phone, recipient.renderedText);
    } else {
      result = await sendWhatsappTemplate(recipient.phone, {
        name: wa.templateName,
        language: wa.templateLanguage,
        params: recipient.params || [],
      });
    }
    recipient.status = result.ok ? "accepted" : "failed";
    recipient.waMessageId = result.id || "";
    recipient.error = result.ok ? "" : result.error;
    recipient.updatedAt = new Date();
  }

  const remaining = message.recipients.filter((r) => r.status === "queued").length;
  if (remaining === 0) {
    message.status = message.recipients.some((r) => r.status === "failed") ? "completed_with_errors" : "completed";
  }
  message.markModified("recipients");
  await message.save();
  return summarizeMessage(message.toObject());
}

export function summarizeMessage(message) {
  const counts = { queued: 0, accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 };
  for (const r of message.recipients || []) counts[r.status] = (counts[r.status] || 0) + 1;
  const { recipients, ...rest } = message;
  return {
    ...rest,
    total: (recipients || []).length,
    counts,
    // "sent" here means confirmed by Meta's webhook (sent, delivered or read)
    confirmedSent: counts.sent + counts.delivered + counts.read,
    pending: counts.queued,
  };
}

export async function listMessages({ kind } = {}) {
  const query = kind ? { kind } : {};
  const messages = await WorkshopWhatsappMessage.find(query).sort({ createdAt: -1 }).limit(200).lean();
  return messages.map(summarizeMessage);
}

export async function getMessage(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const message = await WorkshopWhatsappMessage.findById(id).lean();
  if (!message) return null;
  return { ...summarizeMessage(message), recipients: message.recipients };
}

/** Webhook status updates: never downgrade (e.g. a late "sent" after "read"). */
export async function applyStatusUpdates(body) {
  const statuses = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      for (const status of change?.value?.statuses || []) statuses.push(status);
    }
  }

  for (const status of statuses) {
    const id = status.id;
    const next = String(status.status || "");
    if (!id || !["sent", "delivered", "read", "failed"].includes(next)) continue;
    const message = await WorkshopWhatsappMessage.findOne({ "recipients.waMessageId": id });
    if (!message) continue;
    const recipient = message.recipients.find((r) => r.waMessageId === id);
    if (!recipient) continue;
    if (next === "failed") {
      recipient.status = "failed";
      const err = status.errors?.[0];
      recipient.error = err ? `${err.code}: ${err.error_data?.details || err.title || err.message || "Failed"}` : "Failed";
    } else if ((STATUS_RANK[next] ?? 0) > (STATUS_RANK[recipient.status] ?? 0)) {
      recipient.status = next;
    }
    recipient.updatedAt = new Date();
    message.markModified("recipients");
    await message.save();
  }
  return statuses.length;
}
