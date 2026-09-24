import mongoose from "mongoose";
import {
  EMPLOYMENT_TYPES,
  STAFF_GENDERS,
  STAFF_STATUSES,
  WORK_MODES,
} from "./staff.model.js";

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

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RX = /^[6-9]\d{9}$/;
const IFSC_RX = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function normalizeStaffPayload(raw = {}) {
  const personal = raw.personalDetails && typeof raw.personalDetails === "object" ? raw.personalDetails : {};
  const emergency = raw.emergencyContact && typeof raw.emergencyContact === "object" ? raw.emergencyContact : {};
  const employment = raw.employmentDetails && typeof raw.employmentDetails === "object" ? raw.employmentDetails : {};
  const account = raw.accountDetails && typeof raw.accountDetails === "object" ? raw.accountDetails : {};
  const salary = raw.salaryDetails && typeof raw.salaryDetails === "object" ? raw.salaryDetails : {};
  const bank = raw.bankDetails && typeof raw.bankDetails === "object" ? raw.bankDetails : {};

  const firstName = normalizeString(personal.firstName);
  const middleName = normalizeString(personal.middleName);
  const lastName = normalizeString(personal.lastName);
  const fullName =
    normalizeString(personal.fullName) || [firstName, middleName, lastName].filter(Boolean).join(" ");

  return {
    personalDetails: {
      firstName,
      middleName,
      lastName,
      fullName,
      profilePhoto: normalizeString(personal.profilePhoto),
      parentName: normalizeString(personal.parentName),
      dateOfBirth: toDateOrNull(personal.dateOfBirth),
      gender: STAFF_GENDERS.includes(personal.gender) ? personal.gender : "Male",
      bloodGroup: normalizeString(personal.bloodGroup),
      personalMobile: normalizeString(personal.personalMobile).replace(/\D/g, "").slice(-10),
      whatsapp: normalizeString(personal.whatsapp).replace(/\D/g, "").slice(-10),
      personalEmail: normalizeString(personal.personalEmail).toLowerCase(),
      officialEmail: normalizeString(personal.officialEmail).toLowerCase(),
      alternateContact: normalizeString(personal.alternateContact).replace(/\D/g, "").slice(-10),
      address: normalizeString(personal.address),
      city: normalizeString(personal.city),
      state: normalizeString(personal.state),
      pincode: normalizeString(personal.pincode),
    },
    emergencyContact: {
      name: normalizeString(emergency.name),
      relationship: normalizeString(emergency.relationship),
      phone: normalizeString(emergency.phone).replace(/\D/g, "").slice(-10),
      alternatePhone: normalizeString(emergency.alternatePhone).replace(/\D/g, "").slice(-10),
    },
    employmentDetails: {
      departmentId: mongoose.isValidObjectId(employment.departmentId) ? employment.departmentId : null,
      departmentName: normalizeString(employment.departmentName),
      designationId: mongoose.isValidObjectId(employment.designationId) ? employment.designationId : null,
      designationName: normalizeString(employment.designationName),
      reportingManagerId: mongoose.isValidObjectId(employment.reportingManagerId)
        ? employment.reportingManagerId
        : null,
      reportingManagerName: normalizeString(employment.reportingManagerName),
      branch: normalizeString(employment.branch),
      joiningDate: toDateOrNull(employment.joiningDate),
      employmentType: EMPLOYMENT_TYPES.includes(employment.employmentType) ? employment.employmentType : "Full Time",
      workMode: WORK_MODES.includes(employment.workMode) ? employment.workMode : "Office",
      probationPeriodMonths: Math.max(0, toNumber(employment.probationPeriodMonths, 0)),
      probationEndDate: toDateOrNull(employment.probationEndDate),
      confirmationDate: toDateOrNull(employment.confirmationDate),
      shift: normalizeString(employment.shift),
      weeklyWorkingDays: Math.min(7, Math.max(0, toNumber(employment.weeklyWorkingDays, 6))),
    },
    accountDetails: {
      loginEnabled: Boolean(account.loginEnabled),
      username: normalizeString(account.username || personal.officialEmail).toLowerCase(),
      role: normalizeString(account.role) || "Staff",
      permissions: Array.isArray(account.permissions)
        ? account.permissions.map((p) => normalizeString(p)).filter(Boolean)
        : [],
    },
    password: typeof raw.password === "string" ? raw.password : "",
    salaryDetails: {
      monthlySalary: Math.max(0, toNumber(salary.monthlySalary, 0)),
      basic: Math.max(0, toNumber(salary.basic, 0)),
      hra: Math.max(0, toNumber(salary.hra, 0)),
      allowances: Math.max(0, toNumber(salary.allowances, 0)),
      incentives: Math.max(0, toNumber(salary.incentives, 0)),
      variablePay: Math.max(0, toNumber(salary.variablePay, 0)),
      deductions: Math.max(0, toNumber(salary.deductions, 0)),
    },
    bankDetails: {
      bankName: normalizeString(bank.bankName),
      accountHolderName: normalizeString(bank.accountHolderName),
      accountNumber: normalizeString(bank.accountNumber).replace(/\s+/g, ""),
      ifsc: normalizeString(bank.ifsc).toUpperCase(),
      branch: normalizeString(bank.branch),
    },
    status: STAFF_STATUSES.includes(raw.status) ? raw.status : "Active",
  };
}

/**
 * @param {object} payload normalized payload from normalizeStaffPayload
 * @param {{ isCreate: boolean }} opts
 * @returns {string|null} validation error message, or null when valid
 */
export function validateStaffPayload(payload, { isCreate = false } = {}) {
  if (!payload.personalDetails.firstName) return "First name is required";
  if (
    !payload.personalDetails.personalMobile ||
    !MOBILE_RX.test(payload.personalDetails.personalMobile)
  ) {
    return "Enter a valid 10-digit personal mobile number";
  }
  if (!payload.personalDetails.officialEmail || !EMAIL_RX.test(payload.personalDetails.officialEmail)) {
    return "Enter a valid official email address";
  }
  if (payload.personalDetails.personalEmail && !EMAIL_RX.test(payload.personalDetails.personalEmail)) {
    return "Enter a valid personal email address";
  }
  if (!payload.employmentDetails.joiningDate) return "Joining date is required";
  if (!payload.employmentDetails.departmentId) return "Department is required";
  if (!payload.employmentDetails.designationId) return "Designation is required";
  if (payload.bankDetails.ifsc && !IFSC_RX.test(payload.bankDetails.ifsc)) {
    return "Enter a valid IFSC code (e.g. HDFC0001234)";
  }
  if (payload.accountDetails.loginEnabled) {
    if (!payload.accountDetails.username) return "Username is required when login is enabled";
    if (isCreate && !payload.password) return "Password is required when staff login is enabled";
    if (payload.password && payload.password.length < 6) return "Password must be at least 6 characters";
  }
  return null;
}
