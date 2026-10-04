import crypto from "crypto";
import { WorkshopRateLimit } from "./workshopManagement.model.js";

/** Error with an HTTP status the controllers can pass straight through. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendError(res, err, fallbackMessage, logTag) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ success: false, message: err.message });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ success: false, message: "A record with these details already exists" });
  }
  if (err?.name === "ValidationError") {
    return res.status(400).json({ success: false, message: err.message });
  }
  console.error(`[workshop-mgmt] ${logTag}:`, err);
  return res.status(500).json({ success: false, message: fallbackMessage });
}

/** Today's date (YYYY-MM-DD) in India — sessions are scheduled in IST. */
export function todayIST() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function isValidTimeString(value) {
  return value === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

export function formatTime12(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return String(value || "");
  const hours = Number(match[1]);
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${match[2]} ${hours >= 12 ? "PM" : "AM"}`;
}

export function formatDateLong(value) {
  if (!isValidDateString(value)) return String(value || "");
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatTimeRange(start, end) {
  if (start && end) return `${formatTime12(start)} – ${formatTime12(end)}`;
  return formatTime12(start || end || "");
}

export function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Indian mobile → WhatsApp E.164 without "+", e.g. 919876543210. */
export function toWhatsappNumber(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return "";
}

export function percent(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 10000) / 100;
}

export function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || "unknown";
}

function hashKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

/**
 * Fixed-window limiter stored in Mongo. Returns true when the request is
 * allowed. Fails open on a DB error so a limiter hiccup never blocks a
 * student from marking attendance.
 */
export async function hitRateLimit(bucket, identity, { limit, windowSeconds }) {
  const windowStart = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `${bucket}:${hashKey(identity)}:${windowStart}`;
  try {
    const doc = await WorkshopRateLimit.findOneAndUpdate(
      { key },
      {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt: new Date((windowStart + 1) * windowSeconds * 1000) },
      },
      { upsert: true, returnDocument: "after" }
    ).lean();
    return doc.count <= limit;
  } catch (err) {
    if (err?.code === 11000) return true;
    console.error("[workshop-mgmt] rate limit error:", err?.message || err);
    return true;
  }
}

export function rateLimitMiddleware(bucket, { limit, windowSeconds }) {
  return async (req, res, next) => {
    const allowed = await hitRateLimit(bucket, clientIp(req), { limit, windowSeconds });
    if (!allowed) {
      return res.status(429).json({
        success: false,
        message: "Too many attempts. Please wait a few minutes and try again.",
      });
    }
    return next();
  };
}

export function adminEmail(req) {
  return req.masterAdmin?.email || "master-admin";
}
