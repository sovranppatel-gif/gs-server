import { WorkshopSettings } from "./workshopManagement.model.js";
import { env } from "../../config/env.js";
import { HttpError, isValidDateString, isValidTimeString } from "./workshopManagement.utils.js";

const DEFAULT_TEMPLATES = [
  {
    name: "Session reminder",
    body:
      "Hello {{name}} 👋\n\nTomorrow's Skills Enhance Workshop session is going to be even more interesting! 🚀\n\nTopic:\n{{sessionTitle}}\n\nDate:\n{{date}}\n\nTime:\n{{time}}\n\nAttendance:\n{{attendanceLink}}\n\nDon't miss the session! 🔥\n\nSee you tomorrow!",
  },
  {
    name: "Attendance reminder",
    body:
      "Hi {{name}}, today's session \"{{sessionTitle}}\" is live ({{time}}).\n\nPlease mark your attendance here:\n{{attendanceLink}}\n\nYour Registration ID: {{registrationId}}",
  },
];

/**
 * Returns the settings document, falling back to defaults WITHOUT writing.
 * The document is only created the first time an admin saves Settings.
 */
export async function getSettings() {
  const doc = await WorkshopSettings.findOne({ key: "default" }).lean();
  if (doc) return doc;
  return {
    ...new WorkshopSettings({ key: "default" }).toObject(),
    messageTemplates: DEFAULT_TEMPLATES,
    _id: undefined,
    isDefault: true,
  };
}

export function publicBaseUrl(settings) {
  const base = String(settings?.publicBaseUrl || env.clientUrl || "").trim();
  return base.replace(/\/+$/, "");
}

export function attendanceUrl(settings, session) {
  return `${publicBaseUrl(settings)}/workshop/attendance/${session.slug}`;
}

const ALLOWED_FIELDS = [
  "workshopName",
  "startDate",
  "endDate",
  "defaultStartTime",
  "defaultEndTime",
  "attendanceRequirementPercent",
  "certificateRequireAllTasks",
  "certificatesEnabled",
  "restrictAttendanceToSessionDate",
  "publicBaseUrl",
  "whatsapp",
  "messageTemplates",
];

export async function updateSettings(payload, adminEmail) {
  const updates = {};
  for (const field of ALLOWED_FIELDS) {
    if (payload[field] !== undefined) updates[field] = payload[field];
  }

  for (const field of ["startDate", "endDate"]) {
    if (updates[field] && !isValidDateString(updates[field])) {
      throw new HttpError(400, `${field} must be a valid date`);
    }
  }
  for (const field of ["defaultStartTime", "defaultEndTime"]) {
    if (updates[field] !== undefined && !isValidTimeString(updates[field])) {
      throw new HttpError(400, `${field} must be HH:mm`);
    }
  }
  if (updates.attendanceRequirementPercent !== undefined) {
    const pct = Number(updates.attendanceRequirementPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new HttpError(400, "Attendance requirement must be between 0 and 100");
    }
    updates.attendanceRequirementPercent = pct;
  }
  if (updates.whatsapp) {
    const wa = updates.whatsapp;
    updates.whatsapp = {
      enabled: Boolean(wa.enabled),
      sendMode: wa.sendMode === "text" ? "text" : "template",
      templateName: String(wa.templateName || "").trim(),
      templateLanguage: String(wa.templateLanguage || "en").trim(),
      templateParams: Array.isArray(wa.templateParams)
        ? wa.templateParams.map((p) => String(p).trim()).filter(Boolean)
        : [],
    };
  }
  if (updates.messageTemplates) {
    updates.messageTemplates = (Array.isArray(updates.messageTemplates) ? updates.messageTemplates : [])
      .map((t) => ({ name: String(t.name || "").trim(), body: String(t.body || "") }))
      .filter((t) => t.name && t.body);
  }

  updates.updatedBy = adminEmail;

  const existing = await WorkshopSettings.findOne({ key: "default" }).lean();
  if (!existing && updates.messageTemplates === undefined) {
    updates.messageTemplates = DEFAULT_TEMPLATES;
  }

  return WorkshopSettings.findOneAndUpdate(
    { key: "default" },
    { $set: updates, $setOnInsert: { key: "default" } },
    { upsert: true, returnDocument: "after", runValidators: true }
  ).lean();
}
