/** Turns "Swami Vivekanand Govt. PG College" into "SWAMI_VIVEKANAND_GOVT_PG_COLLEGE" */
export function slugifyReferralCode(collegeName) {
  return String(collegeName || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 40);
}

export const VALID_COURSES = [
  "BCA",
  "MCA",
  "B.Tech",
  "M.Tech",
  "B.Sc",
  "M.Sc",
  "B.Com",
  "MBA",
  "BA",
  "MA",
  "MCOM",
  "Other",
];

export const VALID_SEMESTER_YEARS = [
  "1st Semester",
  "2nd Semester",
  "3rd Semester",
  "4th Semester",
  "5th Semester",
  "6th Semester",
  "7th Semester",
  "8th Semester",
  "1st Year",
  "2nd Year",
  "3rd Year",
  "Final Year",
  "PASSOUT",
];

export const VALID_CODING_EXPERIENCE = [
  "Beginner",
  "Intermediate",
  "Advanced",
  "Professional",
];

export function validateIndianMobile(mobile) {
  const cleaned = String(mobile || "").replace(/\D/g, "").slice(-10);
  return /^[6-9]\d{9}$/.test(cleaned);
}

export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

export function normalizePayload(raw = {}) {
  const fullName = String(raw.fullName || "").trim();
  const mobile = String(raw.mobile || "").replace(/\D/g, "").slice(-10);
  const email = String(raw.email || "").trim().toLowerCase();
  const course = String(raw.course || "").trim();
  const semesterYear = String(raw.semesterYear || "").trim();
  const universityId = raw.universityId || null;
  const collegeName = String(raw.collegeName || "").trim();
  const referralCode = String(raw.referralCode || "").trim().toUpperCase() || null;
  const whatsappNumber = String(raw.whatsappNumber || "").replace(/\D/g, "") || "";
  const githubProfile = String(raw.githubProfile || "").trim();
  const linkedinProfile = String(raw.linkedinProfile || "").trim();
  const codingExperience = String(raw.codingExperience || "").trim();

  return {
    fullName,
    mobile,
    email,
    course,
    semesterYear,
    universityId,
    collegeName,
    referralCode,
    whatsappNumber,
    githubProfile,
    linkedinProfile,
    codingExperience,
  };
}

export function validateSubmission(payload) {
  if (!payload.fullName) {
    return "Full name is required";
  }

  if (!payload.mobile || !validateIndianMobile(payload.mobile)) {
    return "Please enter a valid 10-digit Indian mobile number";
  }

  if (!payload.email || !validateEmail(payload.email)) {
    return "Please enter a valid email address";
  }

  if (!payload.course || !VALID_COURSES.includes(payload.course)) {
    return "Please select a valid course";
  }

  if (!payload.semesterYear || !VALID_SEMESTER_YEARS.includes(payload.semesterYear)) {
    return "Please select a valid semester or year";
  }

  if (!payload.universityId && !payload.collegeName) {
    return "Please select or enter your college name";
  }

  return null;
}
