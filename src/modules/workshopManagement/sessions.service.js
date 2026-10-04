import mongoose from "mongoose";
import {
  WorkshopSession,
  WorkshopAttendance,
  WorkshopTask,
  SESSION_STATUSES,
} from "./workshopManagement.model.js";
import { HttpError, isValidDateString, isValidTimeString } from "./workshopManagement.utils.js";
import { getSettings, attendanceUrl } from "./settings.service.js";
import { loadWorkshopContext, sessionSummary, sortSessions } from "./stats.service.js";

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function uniqueSlug(base, excludeId = null) {
  const root = normalizeSlug(base) || "session";
  for (let i = 0; i < 50; i += 1) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const clash = await WorkshopSession.findOne({
      slug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    }).lean();
    if (!clash) return candidate;
  }
  throw new HttpError(409, "Unable to generate a unique attendance link slug");
}

function cleanPayload(raw = {}, { partial = false } = {}) {
  const out = {};
  const has = (k) => raw[k] !== undefined;

  if (!partial || has("dayNumber")) {
    const day = Number(raw.dayNumber);
    if (!Number.isInteger(day) || day < 1 || day > 365) throw new HttpError(400, "Day number must be a positive whole number");
    out.dayNumber = day;
  }
  if (!partial || has("title")) {
    out.title = String(raw.title || "").trim();
    if (!out.title) throw new HttpError(400, "Session title is required");
  }
  if (!partial || has("date")) {
    out.date = String(raw.date || "").trim();
    if (!isValidDateString(out.date)) throw new HttpError(400, "A valid session date is required");
  }
  for (const key of ["startTime", "endTime"]) {
    if (!partial || has(key)) {
      out[key] = String(raw[key] || "").trim();
      if (!isValidTimeString(out[key])) throw new HttpError(400, `${key} must be HH:mm`);
    }
  }
  for (const key of ["description", "trainer", "meetingLink"]) {
    if (!partial || has(key)) out[key] = String(raw[key] || "").trim();
  }
  if (out.meetingLink && !/^https?:\/\//i.test(out.meetingLink)) {
    throw new HttpError(400, "Meeting link must start with http:// or https://");
  }
  if (!partial || has("status")) {
    out.status = raw.status || "Scheduled";
    if (!SESSION_STATUSES.includes(out.status)) throw new HttpError(400, "Invalid session status");
  }
  for (const key of ["attendanceEnabled", "reminderEnabled"]) {
    if (!partial || has(key)) out[key] = raw[key] === undefined ? true : Boolean(raw[key]);
  }
  return out;
}

export async function listSessions() {
  const [ctx, settings] = await Promise.all([loadWorkshopContext(), getSettings()]);
  return ctx.sessions.map((session) => ({
    ...session,
    attendanceUrl: attendanceUrl(settings, session),
    summary: sessionSummary(ctx, session),
  }));
}

export async function getSession(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const session = await WorkshopSession.findById(id).lean();
  if (!session) return null;
  const [ctx, settings] = await Promise.all([loadWorkshopContext(), getSettings()]);
  return { ...session, attendanceUrl: attendanceUrl(settings, session), summary: sessionSummary(ctx, session) };
}

export async function createSession(raw, adminEmail) {
  const data = cleanPayload(raw);
  data.slug = await uniqueSlug(raw.slug || `day${data.dayNumber}`);
  data.createdBy = adminEmail;
  const session = await WorkshopSession.create(data);
  return session.toObject();
}

export async function updateSession(id, raw) {
  if (!mongoose.isValidObjectId(id)) return null;
  const existing = await WorkshopSession.findById(id).lean();
  if (!existing) return null;

  const data = cleanPayload(raw, { partial: true });
  // Changing the slug changes the public URL, so only do it when asked to.
  if (raw.slug !== undefined && normalizeSlug(raw.slug) !== existing.slug) {
    data.slug = await uniqueSlug(raw.slug, id);
  }
  return WorkshopSession.findByIdAndUpdate(id, { $set: data }, { returnDocument: "after", runValidators: true }).lean();
}

/**
 * Sessions that already have attendance are protected — deleting them would
 * orphan attendance rows. The admin can set status to "Cancelled" instead.
 */
export async function deleteSession(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const attendanceCount = await WorkshopAttendance.countDocuments({ sessionId: id });
  if (attendanceCount > 0) {
    throw new HttpError(
      409,
      `This session has ${attendanceCount} attendance record(s) and cannot be deleted. Mark it as Cancelled instead.`
    );
  }
  await WorkshopTask.updateMany({ sessionId: id }, { $set: { sessionId: null } });
  return WorkshopSession.findByIdAndDelete(id).lean();
}

export async function getSessionsOrdered() {
  const sessions = await WorkshopSession.find().lean();
  return sessions.sort(sortSessions);
}
