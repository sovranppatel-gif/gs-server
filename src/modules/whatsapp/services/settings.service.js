import { WhatsAppSettings } from "../models/whatsappSettings.model.js";
import { cleanString } from "../whatsapp.utils.js";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Settings diagnostics must not upsert or update timestamps on a GET request. */
export async function readSettings() {
  const saved = await WhatsAppSettings.findOne({ key: 'default' }).lean();
  if (saved) return saved;
  const defaults = new WhatsAppSettings().toObject();
  delete defaults._id;
  return { ...defaults, autoReplyEnabled: null };
}

export async function getSettings() {
  return WhatsAppSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();
}

const keywordList = (v) =>
  [...new Set((Array.isArray(v) ? v : String(v || "").split(",")).map((k) => cleanString(k, 40).toUpperCase()).filter(Boolean))].slice(0, 20);

export async function updateSettings(body = {}, by = "master-admin") {
  const $set = { updatedBy: by };
  for (const key of ["autoReplyEnabled", "fallbackEnabled"]) {
    if (typeof body[key] === "boolean") $set[key] = body[key];
  }
  if (body.fallbackCooldownMinutes !== undefined) {
    $set.fallbackCooldownMinutes = Math.min(24 * 60, Math.max(0, Number(body.fallbackCooldownMinutes) || 0));
  }
  if (body.campaignRatePerMinute !== undefined) {
    $set.campaignRatePerMinute = Math.min(1000, Math.max(1, Number(body.campaignRatePerMinute) || 60));
  }
  for (const key of ["handoverMessage", "optOutConfirmation", "optInConfirmation"]) {
    if (typeof body[key] === "string") $set[key] = cleanString(body[key], 1000);
  }
  if (body.optOutKeywords !== undefined) $set.optOutKeywords = keywordList(body.optOutKeywords);
  if (body.optInKeywords !== undefined) $set.optInKeywords = keywordList(body.optInKeywords);
  if (body.businessHours && typeof body.businessHours === "object") {
    const bh = body.businessHours;
    if (bh.start !== undefined && !TIME_RE.test(bh.start)) throw Object.assign(new Error("Invalid business hours start"), { name: "ValidationError" });
    if (bh.end !== undefined && !TIME_RE.test(bh.end)) throw Object.assign(new Error("Invalid business hours end"), { name: "ValidationError" });
    if (bh.start) $set["businessHours.start"] = bh.start;
    if (bh.end) $set["businessHours.end"] = bh.end;
    if (Array.isArray(bh.days)) $set["businessHours.days"] = [...new Set(bh.days.map(Number).filter((d) => d >= 0 && d <= 6))];
    if (bh.timezone) $set["businessHours.timezone"] = cleanString(bh.timezone, 60);
  }
  await getSettings();
  return WhatsAppSettings.findOneAndUpdate({ key: "default" }, { $set }, { returnDocument: "after", runValidators: true }).lean();
}

/** True when `date` falls inside the configured business hours (in its timezone). */
export function isWithinBusinessHours(settings, date = new Date()) {
  const bh = settings?.businessHours || {};
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: bh.timezone || "Asia/Kolkata",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
  } catch {
    return true;
  }
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const minutes = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  const toMin = (t) => {
    const [h, m] = String(t || "00:00").split(":").map(Number);
    return h * 60 + m;
  };
  if (!(bh.days || []).includes(day)) return false;
  return minutes >= toMin(bh.start) && minutes < toMin(bh.end);
}
