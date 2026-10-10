import { ACADEMIC_DEPARTMENT_STATUSES } from "./academicDepartment.model.js";

function normalizeString(value = "") {
  return String(value ?? "").trim();
}

/** Trim + collapse inner whitespace, so " Computer   Science " → "Computer Science". */
export function cleanName(value = "") {
  return normalizeString(value).replace(/\s+/g, " ");
}

/** Key used for duplicate-name protection — case and spacing insensitive. */
export function normalizeDepartmentName(value = "") {
  return cleanName(value).toLowerCase();
}

function toOptionalInt(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Same 10-digit Indian mobile rule as faculty.validation.js, but landlines
// (with STD code) are common for department offices, so 10–12 digits pass.
const PHONE_RX = /^\d{10,12}$/;
const CODE_RX = /^[A-Z0-9][A-Z0-9-]{0,19}$/;

export function normalizeDepartmentPayload(raw = {}) {
  return {
    name: cleanName(raw.name),
    code: normalizeString(raw.code).toUpperCase().replace(/\s+/g, "-"),
    shortName: cleanName(raw.shortName),
    description: normalizeString(raw.description),
    email: normalizeString(raw.email).toLowerCase(),
    phone: normalizeString(raw.phone).replace(/[\s()+-]/g, ""),
    status: ACADEMIC_DEPARTMENT_STATUSES.includes(raw.status) ? raw.status : "Active",
    establishedYear: toOptionalInt(raw.establishedYear),
    capacity: toOptionalInt(raw.capacity),
    // `undefined` = not sent (leave HOD untouched on update); "" / null = clear.
    hod: raw.hod === undefined ? undefined : normalizeString(raw.hod) || null,
  };
}

/** @returns {string|null} validation error message, or null when valid */
export function validateDepartmentPayload(payload) {
  if (!payload.name) return "Department name is required";
  if (payload.name.length > 120) return "Department name is too long (max 120 characters)";
  if (!payload.code) return "Department code is required";
  if (!CODE_RX.test(payload.code)) {
    return "Department code may only contain letters, numbers and hyphens (max 20 characters)";
  }
  if (payload.shortName.length > 40) return "Short name is too long (max 40 characters)";
  if (payload.description.length > 2000) return "Description is too long (max 2000 characters)";
  if (payload.email && !EMAIL_RX.test(payload.email)) return "Enter a valid email address";
  if (payload.phone && !PHONE_RX.test(payload.phone)) return "Enter a valid phone number (10–12 digits)";
  const currentYear = new Date().getFullYear();
  if (payload.establishedYear !== null) {
    if (Number.isNaN(payload.establishedYear) || payload.establishedYear < 1800 || payload.establishedYear > currentYear) {
      return `Established year must be between 1800 and ${currentYear}`;
    }
  }
  if (payload.capacity !== null) {
    if (Number.isNaN(payload.capacity) || payload.capacity < 0 || payload.capacity > 100000) {
      return "Capacity must be a whole number between 0 and 100000";
    }
  }
  return null;
}
