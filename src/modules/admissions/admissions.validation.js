import mongoose from "mongoose";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[6-9]\d{9}$/;
const PIN_RE = /^\d{6}$/;
const GST_INSTITUTE_ID = "institute-gst";

export function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return digits;
}

export function normalizeRegistration(value) {
  return String(value || "").trim().toUpperCase();
}

export function parseMoneyStrict(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const raw = String(value).replace(/[₹,\s]/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function stringError(value, label, max = 200) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  if (String(value).length > max) return `${label} is too long`;
  return null;
}

function addError(errors, field, message) {
  if (!errors[field]) errors[field] = message;
}

export function validateAdmissionDetails(details = {}, { requireCourse = true } = {}) {
  const errors = {};
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return { errors: { details: "Admission details must be an object" } };
  }

  const textFields = [
    ["nameEnglish", "Applicant name"],
    ["nameHindi", "Hindi name"],
    ["fatherName", "Father name"],
    ["motherName", "Mother name"],
    ["category", "Category"],
    ["village", "Village"],
    ["post", "Post"],
    ["tehsil", "Tehsil"],
    ["permanentAddress", "Permanent address"],
    ["homeAddress", "Home address"],
    ["guardianName", "Guardian name"],
    ["guardianAddress", "Guardian address"],
    ["relation", "Relation"],
    ["session", "Session"],
  ];
  for (const [field, label] of textFields) {
    const error = stringError(details[field], label);
    if (error) addError(errors, field, error);
  }

  if (details.dateOfBirth) {
    const dob = new Date(details.dateOfBirth);
    if (Number.isNaN(dob.getTime()) || dob > new Date()) {
      addError(errors, "dateOfBirth", "Date of birth must be a valid past date");
    }
  }

  if (details.photoPreview && String(details.photoPreview).startsWith("data:")) {
    const photo = String(details.photoPreview);
    if (!/^data:image\/(jpeg|png|webp|gif);base64,/i.test(photo)) {
      addError(errors, "photoPreview", "Photo must be a supported image");
    } else if (photo.length > 2_800_000) {
      addError(errors, "photoPreview", "Photo is too large");
    }
  }

  if (details.pinCode && !PIN_RE.test(String(details.pinCode).trim())) {
    addError(errors, "pinCode", "PIN code must contain 6 digits");
  }

  for (const [field, label] of [
    ["contactNo", "Contact number"],
    ["studentMobile", "Student mobile"],
    ["guardianMobile", "Guardian mobile"],
  ]) {
    if (details[field] && !PHONE_RE.test(normalizePhone(details[field]))) {
      addError(errors, field, `${label} must be a valid Indian mobile number`);
    }
  }

  if (details.registrationNo) {
    const error = stringError(details.registrationNo, "Registration number", 80);
    if (error) addError(errors, "registrationNo", error);
  }

  if (requireCourse) {
    if (!mongoose.isValidObjectId(details.courseId)) {
      addError(errors, "courseId", "A valid course is required");
    }
    if (
      !mongoose.isValidObjectId(details.universityId) &&
      details.universityId !== GST_INSTITUTE_ID
    ) {
      addError(errors, "universityId", "A valid university is required");
    }
  }

  if (details.totalFee !== undefined && parseMoneyStrict(details.totalFee) === null) {
    addError(errors, "totalFee", "Total fee must be a non-negative amount");
  }
  if (
    details.registrationFee !== undefined &&
    parseMoneyStrict(details.registrationFee) === null
  ) {
    addError(errors, "registrationFee", "Registration fee must be a non-negative amount");
  }

  const education = Array.isArray(details.education) ? details.education : [];
  education.forEach((row, index) => {
    if (!row || typeof row !== "object") {
      addError(errors, `education.${index}`, "Education row is invalid");
      return;
    }
    const hasValues = Object.values(row).some(
      (value) => value !== undefined && value !== null && String(value).trim() !== ""
    );
    if (!hasValues) return;
    if (!String(row.className || row.board || "").trim()) {
      addError(errors, `education.${index}.className`, "Qualification or class is required");
    }
    if (
      row.year &&
      (!/^\d{4}$/.test(String(row.year)) ||
        Number(row.year) < 1900 ||
        Number(row.year) > new Date().getFullYear() + 1)
    ) {
      addError(errors, `education.${index}.year`, "Passing year is invalid");
    }
    if (row.percentage !== undefined && String(row.percentage).trim() !== "") {
      const percentage = Number(row.percentage);
      if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
        addError(errors, `education.${index}.percentage`, "Percentage must be between 0 and 100");
      }
    }
  });

  return { errors };
}

export function validateAdmissionPayload(payload, { requireCourse = true } = {}) {
  const errors = {};
  if (!payload.applicant) errors.applicant = "Applicant name is required";
  if (!payload.email) errors.email = "Email is required";
  else if (!EMAIL_RE.test(payload.email)) errors.email = "Invalid email address";
  if (!payload.phone) errors.phone = "Phone number is required";
  else if (!PHONE_RE.test(normalizePhone(payload.phone))) {
    errors.phone = "Phone number must be a valid Indian mobile number";
  }
  if (!payload.course) errors.course = "Please select a course";

  const detailsResult = validateAdmissionDetails(payload.details, { requireCourse });
  Object.assign(errors, detailsResult.errors);
  return errors;
}

export { EMAIL_RE, PHONE_RE, PIN_RE, GST_INSTITUTE_ID };