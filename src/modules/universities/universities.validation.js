function normalizeString(value = "") {
  return String(value || "").trim();
}

// Same shape used across the codebase (faculty.validation.js) for a plain
// "looks like an email" check — good enough to reject typos, doesn't try to
// be RFC 5322-complete.
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Universities are contacted on office landlines with an STD code
// ("0755-4902230") as often as a mobile number, plus optional "+91" and
// extensions — so this deliberately doesn't reuse faculty's strict 10-digit
// mobile regex. It just rejects things that clearly aren't a phone number
// (letters, or too few digits) while collapsing stray whitespace.
const PHONE_ALLOWED_RX = /^[0-9+\-().\s]+$/;

function normalizePhone(raw) {
  const value = normalizeString(raw);
  if (!value) return "";
  // Collapse runs of internal whitespace but keep the separators the admin typed.
  return value.replace(/\s+/g, " ");
}

function isValidPhone(value) {
  if (!value) return true; // optional field
  if (!PHONE_ALLOWED_RX.test(value)) return false;
  const digitCount = value.replace(/\D/g, "").length;
  return digitCount >= 7 && digitCount <= 15;
}

/**
 * Accepts a bare domain ("www.example.edu") the same way the UI's
 * placeholder ("https://...") invites, and normalizes it to a full https URL
 * rather than rejecting it outright. Anything that still isn't a parseable
 * URL after that is treated as invalid.
 */
function normalizeWebsite(raw) {
  const value = normalizeString(raw);
  if (!value) return "";
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    if (!url.hostname.includes(".")) return null;
    return withProtocol;
  } catch {
    return null;
  }
}

export function normalizeUniversityPayload(raw = {}) {
  return {
    name: normalizeString(raw.name),
    shortName: normalizeString(raw.shortName).toUpperCase(),
    universityCode: normalizeString(raw.universityCode).toUpperCase(),
    registrationNumber: normalizeString(raw.registrationNumber).toUpperCase(),
    affiliationNumber: normalizeString(raw.affiliationNumber).toUpperCase(),
    city: normalizeString(raw.city),
    state: normalizeString(raw.state),
    contactPerson: normalizeString(raw.contactPerson),
    contactPhone: normalizePhone(raw.contactPhone),
    contactEmail: normalizeString(raw.contactEmail).toLowerCase(),
    // `undefined` (not "") signals "the admin typed something unparseable" to
    // validateUniversityPayload, vs. "" meaning the field was left blank.
    website: normalizeWebsite(raw.website) ?? undefined,
    status: normalizeString(raw.status || "Active") || "Active",
    remarks: normalizeString(raw.remarks),
  };
}

export function validateUniversityPayload(payload) {
  if (!payload.name) return "University name is required";
  if (!payload.shortName) return "Short name is required";
  if (!payload.registrationNumber) return "Registration number is required";
  if (!["Active", "Inactive", "Draft"].includes(payload.status)) {
    return "Status must be Active, Inactive, or Draft";
  }
  if (payload.contactEmail && !EMAIL_RX.test(payload.contactEmail)) {
    return "Enter a valid contact email address";
  }
  if (!isValidPhone(payload.contactPhone)) {
    return "Enter a valid contact phone number";
  }
  if (payload.website === undefined) {
    return "Enter a valid website URL (e.g. https://university.edu)";
  }
  return null;
}
