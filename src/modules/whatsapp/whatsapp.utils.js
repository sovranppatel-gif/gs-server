import { safeError } from "./whatsapp.security.js";
import { currentExecution } from "./services/execution.service.js";
import mongoose from "mongoose";
import { emitSectionUpdate } from "../../lib/socket.js";

/** Staff statuses that still count as working here (for audiences / assignment). */
export const CURRENT_STAFF_STATUSES = Object.freeze(["Active", "Probation", "Notice Period"]);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const notFound = (message = "Not found") => new HttpError(404, message);

export function assertObjectId(id, label = "id") {
  if (!mongoose.isValidObjectId(id)) throw badRequest(`Invalid ${label}`);
  return new mongoose.Types.ObjectId(String(id));
}

export function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cleanString(value, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

export function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(list.map((t) => cleanString(t, 40).toLowerCase()).filter(Boolean))].slice(0, 30);
}

export function parsePaging(query = {}, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

export function pageResult(rows, total, { page, limit }) {
  return { rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

export function parseDateRange(query = {}, defaultDays = 30) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - defaultDays * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest("Invalid date range");
  if (query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to)) to.setHours(23, 59, 59, 999);
  return { from, to };
}

export function editor(req) {
  return req.masterAdmin?.email || "master-admin";
}

/** Live refresh hint for the admin UI. Never carries message bodies or phones. */
export function notifyAdmin(action, extra = {}) {
  if (currentExecution()) return; // worker notifies after transaction commit
  try {
    emitSectionUpdate({ section: "whatsapp", action, at: new Date().toISOString(), ...extra });
  } catch {
    /* socket is optional (serverless) */
  }
}

/** Wraps a service call into an Express handler with the project's JSON shape. */
export function handle(fn, { status = 200, key = "data", tag = "request", errorMessage = "Request failed" } = {}) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      if (res.headersSent) return undefined;
      return res.status(status).json({ success: true, [key]: result });
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message });
      if (err?.name === "ValidationError" || err?.name === "CastError") {
        return res.status(400).json({ success: false, message: err.message });
      }
      if (err?.code === 11000) return res.status(409).json({ success: false, message: "Duplicate record" });
      console.error(`[whatsapp] ${tag} error:`, safeError(err));
      return res.status(500).json({ success: false, message: errorMessage });
    }
  };
}
