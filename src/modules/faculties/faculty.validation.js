import {
  EMPLOYMENT_TYPES,
  FACULTY_GENDERS,
  FACULTY_STATUSES,
} from "./faculty.model.js";

function normalizeString(value = "") {
  return String(value ?? "").trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Today's calendar date in IST, stored as a UTC-midnight Date — so it reads
 * back as the same day regardless of the reading server's local timezone
 * (see faculty.service.js's dateInputValue/formatDateLabel, which both read
 * UTC Y/M/D). Using plain `new Date()` here would default a joining date
 * entered in India's evening (already past midnight IST but still "today"
 * in UTC-1) to the wrong calendar day. */
function todayIst() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RX = /^[6-9]\d{9}$/;

export function normalizeFacultyPayload(raw = {}) {
  const personal = raw.personalDetails && typeof raw.personalDetails === "object" ? raw.personalDetails : {};
  const employment = raw.employmentDetails && typeof raw.employmentDetails === "object" ? raw.employmentDetails : {};
  const account = raw.accountDetails && typeof raw.accountDetails === "object" ? raw.accountDetails : {};

  return {
    personalDetails: {
      fullName: normalizeString(personal.fullName || raw.fullName),
      profilePhoto: normalizeString(personal.profilePhoto || raw.profilePhoto),
      gender: FACULTY_GENDERS.includes(personal.gender) ? personal.gender : "Male",
      dateOfBirth: toDateOrNull(personal.dateOfBirth),
      fatherOrHusbandName: normalizeString(personal.fatherOrHusbandName),
      mobile: normalizeString(personal.mobile || raw.mobile).replace(/\D/g, "").slice(-10),
      alternateMobile: normalizeString(personal.alternateMobile).replace(/\D/g, "").slice(-10),
      email: normalizeString(personal.email || raw.email).toLowerCase(),
      address: normalizeString(personal.address),
      city: normalizeString(personal.city),
      state: normalizeString(personal.state),
      pincode: normalizeString(personal.pincode),
    },
    employmentDetails: {
      designation: normalizeString(employment.designation || raw.designation),
      department: normalizeString(employment.department || raw.department),
      qualification: normalizeString(employment.qualification),
      specialization: normalizeString(employment.specialization),
      experienceYears: Math.max(0, toNumber(employment.experienceYears, 0)),
      joiningDate: toDateOrNull(employment.joiningDate || raw.joiningDate) || todayIst(),
      employmentType: EMPLOYMENT_TYPES.includes(employment.employmentType)
        ? employment.employmentType
        : "Full Time",
    },
    accountDetails: {
      loginEnabled: Boolean(account.loginEnabled),
      username: normalizeString(account.username || personal.email || raw.email).toLowerCase(),
    },
    password: typeof raw.password === "string" ? raw.password : "",
    status: FACULTY_STATUSES.includes(raw.status) ? raw.status : "Active",
    permissions: Array.isArray(raw.permissions)
      ? raw.permissions.map((p) => normalizeString(p)).filter(Boolean)
      : [],
  };
}

/**
 * @param {object} payload normalized payload from normalizeFacultyPayload
 * @param {{ isCreate: boolean }} opts
 * @returns {string|null} validation error message, or null when valid
 */
export function validateFacultyPayload(payload, { isCreate = false } = {}) {
  if (!payload.personalDetails.fullName) return "Full name is required";
  if (!payload.personalDetails.mobile || !MOBILE_RX.test(payload.personalDetails.mobile)) {
    return "Enter a valid 10-digit mobile number";
  }
  if (
    payload.personalDetails.alternateMobile &&
    !MOBILE_RX.test(payload.personalDetails.alternateMobile)
  ) {
    return "Enter a valid 10-digit alternate mobile number";
  }
  if (!payload.personalDetails.email || !EMAIL_RX.test(payload.personalDetails.email)) {
    return "Enter a valid email address";
  }
  if (!payload.employmentDetails.designation) return "Designation is required";
  if (payload.employmentDetails.experienceYears < 0) return "Experience cannot be negative";
  if (payload.accountDetails.loginEnabled) {
    if (!payload.accountDetails.username) return "Username is required when login is enabled";
    if (isCreate && !payload.password) {
      return "Password is required when faculty login is enabled";
    }
    if (payload.password && payload.password.length < 6) {
      return "Password must be at least 6 characters";
    }
  }
  return null;
}
