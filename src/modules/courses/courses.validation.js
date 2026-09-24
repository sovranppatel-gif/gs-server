function normalizeString(value = "") {
  return String(value || "").trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSubjects(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const name = normalizeString(item.name);
      if (!name) return null;
      return {
        name,
        code: normalizeString(item.code).toUpperCase(),
        theoryHours: toNumber(item.theoryHours, 0),
        practicalHours: toNumber(item.practicalHours, 0),
        credits: toNumber(item.credits, 0),
      };
    })
    .filter(Boolean);
}

function normalizeSemesters(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const number = toNumber(item.number, index + 1);
      if (number < 1) return null;
      const subjects = normalizeSubjects(item.subjects);
      return {
        number,
        title: normalizeString(item.title) || `Semester ${number}`,
        durationMonths: toNumber(item.durationMonths, 0),
        description: normalizeString(item.description),
        subjects,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number);
}

function normalizeHighlights(raw) {
  if (!Array.isArray(raw)) {
    if (typeof raw === "string" && raw.trim()) {
      return raw
        .split(/\n|,/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  }
  return raw.map((item) => normalizeString(item)).filter(Boolean);
}

function normalizeFees(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    total: normalizeString(src.total),
    registration: normalizeString(src.registration),
    exam: normalizeString(src.exam),
    installmentAllowed:
      typeof src.installmentAllowed === "boolean" ? src.installmentAllowed : true,
  };
}

function buildDurationLabel(months, explicit = "") {
  const label = normalizeString(explicit);
  if (label) return label;
  const m = toNumber(months, 0);
  if (m <= 0) return "";
  if (m === 12) return "1 year";
  if (m === 6) return "6 months";
  if (m % 12 === 0) return `${m / 12} years`;
  return `${m} months`;
}

export function normalizeCoursePayload(raw = {}) {
  const semesters = normalizeSemesters(raw.semesters);
  const durationMonths = toNumber(raw.durationMonths, 6);
  const semesterCount =
    toNumber(raw.semesterCount, 0) || semesters.length || 0;

  return {
    name: normalizeString(raw.name),
    code: normalizeString(raw.code).toUpperCase(),
    type: normalizeString(raw.type || "University") || "University",
    universityId: raw.universityId ? String(raw.universityId) : null,
    universityName: normalizeString(raw.universityName),
    universityShortName: normalizeString(raw.universityShortName).toUpperCase(),
    category: normalizeString(raw.category || "Diploma") || "Diploma",
    durationMonths,
    durationLabel: buildDurationLabel(durationMonths, raw.durationLabel),
    semesterCount,
    semesters,
    fees: normalizeFees(raw.fees),
    eligibility: normalizeString(raw.eligibility),
    mode: normalizeString(raw.mode || "Offline") || "Offline",
    description: normalizeString(raw.description),
    highlights: normalizeHighlights(raw.highlights),
    status: normalizeString(raw.status || "Active") || "Active",
    remarks: normalizeString(raw.remarks),
  };
}

export function validateCoursePayload(payload) {
  if (!payload.name) return "Course name is required";
  if (!["University", "Institute"].includes(payload.type)) {
    return "Type must be University or Institute";
  }
  if (payload.type === "University" && !payload.universityId) {
    return "University is required for university-linked courses";
  }
  if (
    !["Diploma", "Certificate", "Degree", "PG Diploma", "Training", "Other"].includes(
      payload.category
    )
  ) {
    return "Invalid course category";
  }
  if (!["Offline", "Online", "Hybrid"].includes(payload.mode)) {
    return "Mode must be Offline, Online, or Hybrid";
  }
  if (!["Active", "Inactive", "Draft"].includes(payload.status)) {
    return "Status must be Active, Inactive, or Draft";
  }
  if (payload.durationMonths < 0) return "Duration months cannot be negative";
  if (payload.semesterCount < 0) return "Semester count cannot be negative";
  for (const sem of payload.semesters) {
    if (!sem.number) return "Each semester needs a number";
    for (const subject of sem.subjects) {
      if (!subject.name) return "Each subject must have a name";
    }
  }
  return null;
}
