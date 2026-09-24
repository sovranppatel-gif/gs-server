import { Router } from "express";
import mongoose from "mongoose";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import {
  Admission,
  ADMISSION_MODES,
  ADMISSION_STATUSES,
} from "../models/Admission.js";
import { AdmissionDocument } from "../models/AdmissionDocument.js";
import { AdmissionIdempotency } from "../models/AdmissionIdempotency.js";
import { requireMasterAdminJwt } from "../middleware/requireMasterAdminJwt.js";
import { requireStudentJwt } from "../middleware/requireStudentJwt.js";
import {
  verifyMasterAdminToken,
  verifyStudentToken,
} from "../lib/jwt.js";
import { educationDocumentUpload } from "../modules/admissions/admissions.upload.js";
import { notifyAdmissionStatusChange } from "../lib/studentNotifications.js";
import { upsertFeeFromAdmission } from "../modules/fees/fees.service.js";
import { University } from "../modules/universities/universities.model.js";
import { Course } from "../modules/courses/courses.model.js";
import { reserveNextSequence } from "../lib/sequence.js";
import {
  GST_INSTITUTE_ID,
  normalizePhone,
  normalizeRegistration,
  parseMoneyStrict,
  validateAdmissionPayload,
} from "../modules/admissions/admissions.validation.js";

const router = Router();

const UPLOAD_ROOT = path.join(process.cwd(), "uploads", "admissions", "education");

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function courseOption(doc) {
  const name = String(doc.name || "").trim();
  const code = String(doc.code || "").trim();
  return {
    id: String(doc._id),
    _id: String(doc._id),
    name,
    code,
    label: code ? `${name} (${code})` : name,
    durationLabel: doc.durationLabel || "",
    semesterCount: Number(doc.semesterCount) || 0,
    category: doc.category || "",
    feesTotal: doc.fees?.total || "",
    feesRegistration: doc.fees?.registration || "",
    feesExam: doc.fees?.exam || "",
    type: doc.type || "University",
  };
}

/**
 * Active universities + courses for student online admission / public catalog.
 * Source of truth: master-admin Universities + Courses modules.
 */
async function buildAdmissionCatalog() {
  const [universities, courses] = await Promise.all([
    University.find({ softDelete: false, status: "Active" })
      .select("name shortName")
      .sort({ name: 1 })
      .lean()
      .maxTimeMS(8000),
    Course.find({ softDelete: false, status: "Active" })
      .select(
        "name code type universityId universityShortName universityName durationLabel semesterCount category fees"
      )
      .sort({ name: 1 })
      .lean()
      .maxTimeMS(8000),
  ]);

  const byUni = new Map();
  for (const uni of universities) {
    const id = String(uni._id);
    const shortName = String(uni.shortName || "").trim();
    const name = String(uni.name || "").trim();
    byUni.set(id, {
      id,
      _id: id,
      name,
      shortName,
      label: shortName && name ? `${shortName} — ${name}` : shortName || name,
      type: "University",
      courses: [],
    });
  }

  let gstBucket = null;
  const ensureGst = () => {
    if (!gstBucket) {
      gstBucket = {
        id: GST_INSTITUTE_ID,
        _id: GST_INSTITUTE_ID,
        name: "Grow Skills Tech",
        shortName: "GST",
        label: "GST — Grow Skills Tech (Institute Training)",
        type: "Institute",
        courses: [],
      };
    }
    return gstBucket;
  };

  for (const doc of courses) {
    const option = courseOption(doc);
    if (!option.name) continue;

    if (doc.type === "Institute" || !doc.universityId) {
      ensureGst().courses.push(option);
      continue;
    }

    const uniId = String(doc.universityId);
    const bucket = byUni.get(uniId);
    if (bucket) {
      bucket.courses.push(option);
    } else {
      // Orphan university-linked course — still show under GST so student can apply
      ensureGst().courses.push(option);
    }
  }

  const universityList = [...byUni.values()].filter((u) => u.courses.length > 0);
  if (gstBucket?.courses.length) {
    universityList.push(gstBucket);
  }

  return {
    universities: universityList,
    totalCourses: universityList.reduce((sum, u) => sum + u.courses.length, 0),
  };
}

/** Student or master-admin JWT (for education marksheet uploads). */
function requireStudentOrMasterAdminJwt(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res
      .status(401)
      .json({ success: false, message: "Authorization required" });
  }

  const raw = token.trim();
  try {
    const decoded = verifyStudentToken(raw);
    req.student = {
      sub: decoded.sub,
      email: decoded.email,
      name: decoded.name,
      phone: decoded.phone || null,
    };
    return next();
  } catch {
    // fall through to master-admin
  }

  try {
    const decoded = verifyMasterAdminToken(raw);
    req.masterAdmin = {
      sub: decoded.sub,
      email: decoded.email,
      name: decoded.name,
    };
    return next();
  } catch (e) {
    return res.status(401).json({
      success: false,
      message:
        e.name === "TokenExpiredError"
          ? "Token expired"
          : "Invalid or expired token",
    });
  }
}

/** Same IT training courses as landing “Connect With Grow Skills Tech” */
export const TRAINING_COURSES = [
  "Full-Stack MERN Development (React, Node, MongoDB)",
  "Frontend Engineering (React.js / Next.js Pro)",
  "Backend Architecture & API Development",
  "Mobile App Development (React Native / Flutter)",
  "Python, Data Analytics & AI/ML Basics",
  "UI/UX Design & Figma Mastery",
  "Industrial Training / College Internship Program",
  "Custom Corporate / Batch Training",
];

async function nextAdmissionId({ session = null } = {}) {
  const year = new Date().getFullYear();
  const prefix = `ADM-${year}-`;
  const seq = await reserveNextSequence({
    key: `admission:${year}`,
    session,
    readMax: async () => {
      const rows = await Admission.find({ admissionId: new RegExp(`^${prefix}`) })
        .select("admissionId")
        .session(session)
        .lean();
      return rows.reduce((max, row) => {
        const n = parseInt(String(row.admissionId || "").slice(prefix.length), 10);
        return Number.isFinite(n) && n > max ? n : max;
      }, 0);
    },
  });
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

function normalizeAdmissionDetails(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const details = { ...raw };
  const gender = String(details.gender || "").trim();
  const maritalStatus = String(details.maritalStatus || "").trim();
  const husbandName = String(details.husbandName || "")
    .trim()
    .toUpperCase();

  details.gender = gender;
  details.maritalStatus = maritalStatus;
  details.husbandName =
    gender === "Female" && maritalStatus === "Married" ? husbandName : "";

  return details;
}

function normalizePayload(raw = {}) {
  const mode = ADMISSION_MODES.includes(String(raw.mode || "").trim())
    ? String(raw.mode).trim()
    : "Online";
  const status = ADMISSION_STATUSES.includes(String(raw.status || "").trim())
    ? String(raw.status).trim()
    : "Pending";

  const details = normalizeAdmissionDetails(raw.details);

  return {
    applicant: String(raw.applicant || "").trim(),
    email: String(raw.email || "").trim().toLowerCase(),
    phone: normalizePhone(raw.phone),
    course: String(raw.course || "").trim(),
    mode,
    counsellor: String(raw.counsellor || "").trim(),
    fee: String(raw.fee || "₹5,000").trim() || "₹5,000",
    status,
    city: String(raw.city || "").trim(),
    state: String(raw.state || "").trim(),
    college: String(raw.college || "").trim(),
    studentStatus: String(raw.studentStatus || "").trim(),
    notes: String(raw.notes || "").trim(),
    ...(details !== undefined ? { details } : {}),
  };
}

function validatePayload(payload, options = {}) {
  return validateAdmissionPayload(payload, options);
}

function validationResponse(res, errors) {
  return res.status(422).json({
    success: false,
    message: "Validation failed",
    errors,
  });
}

function requestHash(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function claimIdempotency(key, payload) {
  if (!key) return { record: null, replay: null };
  const requestHashValue = requestHash(payload);
  try {
    const record = await AdmissionIdempotency.create({
      key,
      requestHash: requestHashValue,
    });
    return { record, replay: null };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const existing = await AdmissionIdempotency.findOne({ key }).lean();
    if (!existing) throw err;
    if (existing.requestHash !== requestHashValue) {
      const conflict = new Error("Idempotency key was used with a different request");
      conflict.status = 409;
      throw conflict;
    }
    if (existing.status === "completed" && existing.responseEntry) {
      return { record: existing, replay: existing.responseEntry };
    }
    const processing = new Error("Admission creation is already in progress");
    processing.status = 409;
    throw processing;
  }
}

async function completeIdempotency(record, entry) {
  if (!record?._id) return;
  await AdmissionIdempotency.updateOne(
    { _id: record._id },
    { $set: { status: "completed", admissionId: entry._id, responseEntry: entry } }
  );
}

async function releaseIdempotency(record) {
  if (record?._id) await AdmissionIdempotency.deleteOne({ _id: record._id });
}

function collectDocumentNames(details = {}) {
  const values = [];
  for (const row of Array.isArray(details.education) ? details.education : []) {
    if (row?.documentUrl) values.push(String(row.documentUrl));
  }
  return values
    .map((url) => url.match(/\/api\/admissions\/documents\/([^/?#]+)/i)?.[1])
    .filter(Boolean)
    .map((name) => decodeURIComponent(name));
}

async function attachAdmissionDocuments(details, admissionId, { session = null } = {}) {
  const names = collectDocumentNames(details);
  if (!names.length) return;
  const docs = await AdmissionDocument.find({ storageName: { $in: names } }).session(session);
  if (docs.length !== names.length) {
    throw new Error("One or more admission documents are unavailable");
  }
  await AdmissionDocument.updateMany(
    { storageName: { $in: names }, admissionId: null },
    { $set: { admissionId, expiresAt: new Date("2100-01-01") } },
    session ? { session } : undefined
  );
}

async function cleanupTemporaryDocuments(details = {}) {
  const names = collectDocumentNames(details);
  if (!names.length) return;
  const docs = await AdmissionDocument.find({ storageName: { $in: names }, admissionId: null }).lean();
  await Promise.all(
    docs.map(async (doc) => {
      await fs.unlink(path.join(UPLOAD_ROOT, doc.storageName)).catch(() => {});
    })
  );
  await AdmissionDocument.deleteMany({ _id: { $in: docs.map((doc) => doc._id) } });
}

async function resolveAuthoritativeCourse(payload, { session = null } = {}) {
  const details = payload.details || {};
  const errors = {};
  if (!mongoose.isValidObjectId(details.courseId)) {
    return { errors: { courseId: "A valid course is required" } };
  }

  const course = await Course.findOne({
    _id: details.courseId,
    softDelete: false,
  })
    .session(session)
    .lean();
  if (!course) return { errors: { courseId: "Selected course was not found" } };
  if (course.status !== "Active") {
    return { errors: { courseId: "Selected course is no longer active" } };
  }

  if (course.universityId && String(course.universityId) !== String(details.universityId)) {
    errors.universityId = "Selected course does not belong to this university";
  }
  if (details.universityId === GST_INSTITUTE_ID && course.type !== "Institute") {
    errors.universityId = "Selected course is not an institute course";
  }
  if (mongoose.isValidObjectId(details.universityId)) {
    const university = await University.findOne({
      _id: details.universityId,
      softDelete: false,
      status: "Active",
    })
      .session(session)
      .lean();
    if (!university) errors.universityId = "Selected university is not active";
  }

  const totalFee = parseMoneyStrict(course.fees?.total);
  const registrationFee = parseMoneyStrict(course.fees?.registration) ?? 0;
  if (totalFee === null) errors.totalFee = "Selected course has no configured fee";
  if (totalFee !== null && registrationFee > totalFee) {
    errors.registrationFee = "Course registration fee exceeds total fee";
  }

  const paymentAmount = parseMoneyStrict(details.payment?.amount);
  if (details.payment?.amount !== undefined && paymentAmount === null) {
    errors.paymentAmount = "Payment amount must be a non-negative amount";
  } else if (paymentAmount !== null && totalFee !== null && paymentAmount > totalFee) {
    errors.paymentAmount = "Payment amount cannot exceed the course fee";
  }

  if (Object.keys(errors).length) return { errors };

  const nextDetails = {
    ...details,
    courseId: String(course._id),
    courseName: String(course.name || "").trim(),
    courseCode: String(course.code || "").trim(),
    universityName: String(course.universityName || details.universityName || "").trim(),
    universityShortName: String(
      course.universityShortName || details.universityShortName || ""
    ).trim(),
    totalFee: totalFee === 0 ? "₹0" : String(course.fees?.total || "").trim(),
    registrationFee:
      registrationFee === 0 ? "₹0" : String(course.fees?.registration || "").trim(),
  };

  const courseLabel = course.code
    ? `${String(course.name || "").trim()} (${String(course.code).trim()})`
    : String(course.name || "").trim();
  return {
    course,
    payload: {
      ...payload,
      course: courseLabel,
      fee: nextDetails.totalFee,
      college: nextDetails.universityName || payload.college,
      details: nextDetails,
    },
  };
}

async function findDuplicateAdmission(payload, currentId = null, { session = null } = {}) {
  const details = payload.details || {};
  const activeStatuses = { $in: ["Pending", "Verification", "Approved"] };
  const email = payload.email;
  const phone = normalizePhone(payload.phone);
  const registrationNo = normalizeRegistration(details.registrationNo);
  const courseKey = String(details.courseId || "");
  const sessionKey = String(details.session || "").trim().toUpperCase();
  const or = [];

  if (registrationNo) {
    or.push(
      { normalizedRegistrationNo: registrationNo },
      { "details.registrationNo": registrationNo }
    );
  }
  if (email && courseKey && sessionKey) {
    or.push(
      { normalizedEmail: email, courseKey, sessionKey, status: activeStatuses },
      { email, "details.courseId": courseKey, "details.session": sessionKey, status: activeStatuses }
    );
  }
  if (phone && courseKey && sessionKey) {
    or.push(
      { normalizedPhone: phone, courseKey, sessionKey, status: activeStatuses },
      { phone, "details.courseId": courseKey, "details.session": sessionKey, status: activeStatuses }
    );
  }
  if (!or.length) return null;

  const query = { $or: or };
  if (currentId) query._id = { $ne: currentId };
  return Admission.findOne(query).select("admissionId applicant email phone details status").session(session).lean();
}

function duplicateErrors(existing, payload) {
  if (!existing) return {};
  const details = payload.details || {};
  const errors = {};
  if (
    normalizeRegistration(details.registrationNo) &&
    normalizeRegistration(details.registrationNo) ===
      normalizeRegistration(existing.details?.registrationNo)
  ) {
    errors.registrationNo = `Registration number is already used by ${existing.admissionId}`;
  }
  if (existing.email === payload.email) errors.email = `An admission already exists for this email (${existing.admissionId})`;
  if (existing.phone === normalizePhone(payload.phone)) errors.phone = `An admission already exists for this phone (${existing.admissionId})`;
  if (!Object.keys(errors).length) errors.admission = `A duplicate admission already exists (${existing.admissionId})`;
  return errors;
}

function storedIdentityFields(payload) {
  const details = payload.details || {};
  return {
    normalizedEmail: payload.email,
    normalizedPhone: normalizePhone(payload.phone),
    normalizedRegistrationNo: normalizeRegistration(details.registrationNo),
    courseKey: String(details.courseId || ""),
    sessionKey: String(details.session || "").trim().toUpperCase(),
  };
}

async function createAdmissionWithFee(payload, admissionDate, createdBy) {
  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      const admissionId = await nextAdmissionId({ session });
      [created] = await Admission.create(
        [{ ...payload, ...storedIdentityFields(payload), admissionId, admissionDate, createdBy }],
        { session }
      );
      await attachAdmissionDocuments(payload.details, created._id, { session });
      await upsertFeeFromAdmission(created, { session });
    });
    return created;
  } finally {
    await session.endSession();
  }
}

/** Strip base64 photos/docs from list payloads — keeps list API fast. */
function slimDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (value == null) continue;
    if (typeof value === "string") {
      if (value.startsWith("data:")) {
        if (key === "photoPreview" || /photo/i.test(key)) out.hasPhoto = true;
        else out[`has_${key}`] = true;
        continue;
      }
      if (value.length > 2000) continue;
    }
    if (
      key === "photoPreview" ||
      key === "photo" ||
      key === "educationDocument" ||
      key === "marksheetData" ||
      key === "documentData"
    ) {
      if (value) out.hasPhoto = key === "photoPreview" || key === "photo" ? true : out.hasPhoto;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function toRow(doc) {
  const d = doc?.toObject ? doc.toObject() : doc;
  return {
    id: d.admissionId,
    _id: String(d._id),
    admissionId: d.admissionId,
    applicant: d.applicant,
    email: d.email,
    phone: d.phone,
    program: d.course,
    course: d.course,
    mode: d.mode,
    counsellor: d.counsellor || "—",
    fee: d.fee,
    status: d.status,
    city: d.city,
    state: d.state,
    college: d.college,
    studentStatus: d.studentStatus,
    notes: d.notes,
    details: d.details && typeof d.details === "object" ? d.details : {},
    date: d.admissionDate
      ? new Date(d.admissionDate).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
      : "—",
    admissionDate: d.admissionDate,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function toListRow(doc) {
  const row = toRow(doc);
  return {
    ...row,
    details: slimDetails(row.details),
  };
}

/**
 * POST /api/admissions/upload-education-document
 * multipart field: file
 * Auth: student or master-admin JWT
 * Max size: 400 KB — PDF or image
 */
router.post(
  "/upload-education-document",
  requireStudentOrMasterAdminJwt,
  (req, res, next) => {
    educationDocumentUpload.single("file")(req, res, (err) => {
      if (err) {
        const isSize =
          err.code === "LIMIT_FILE_SIZE" ||
          /File too large/i.test(String(err.message || ""));
        return res.status(400).json({
          success: false,
          message: isSize
            ? "Document must be 400 KB or smaller"
            : err.message || "Upload failed",
        });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file?.filename) {
        return res
          .status(400)
          .json({ success: false, message: "No document file received" });
      }
      const document = await AdmissionDocument.create({
        storageName: req.file.filename,
        originalName: req.file.originalname || req.file.filename,
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedByType: req.masterAdmin ? "master-admin" : "student",
        uploadedByEmail: req.masterAdmin?.email || req.student?.email || "",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      const url = `/api/admissions/documents/${encodeURIComponent(document.storageName)}`;
      return res.status(201).json({
        success: true,
        message: "Document uploaded",
        data: {
          url,
          name: req.file.originalname || req.file.filename,
          size: req.file.size,
          mimeType: req.file.mimetype,
        },
      });
    } catch (err) {
      if (req.file?.filename) {
        await fs.unlink(path.join(UPLOAD_ROOT, req.file.filename)).catch(() => {});
      }
      console.error("admission education upload error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to upload document" });
    }
  }
);

router.get("/documents/:storageName", requireStudentOrMasterAdminJwt, async (req, res) => {
  try {
    const storageName = path.basename(String(req.params.storageName || ""));
    if (!storageName || storageName !== req.params.storageName) {
      return res.status(400).json({ success: false, message: "Invalid document" });
    }
    const document = await AdmissionDocument.findOne({ storageName }).lean();
    if (!document) return res.status(404).json({ success: false, message: "Document not found" });

    if (req.student) {
      const ownsUpload = document.uploadedByEmail === String(req.student.email || "").toLowerCase();
      let ownsAdmission = false;
      if (!ownsUpload && document.admissionId) {
        ownsAdmission = Boolean(
          await Admission.exists({ _id: document.admissionId, email: String(req.student.email || "").toLowerCase() })
        );
      }
      if (!ownsUpload && !ownsAdmission) {
        return res.status(403).json({ success: false, message: "Document access denied" });
      }
    }

    res.type(document.mimeType);
    return createReadStream(path.join(UPLOAD_ROOT, document.storageName))
      .on("error", () => {
        if (!res.headersSent) res.status(404).json({ success: false, message: "Document not found" });
      })
      .pipe(res);
  } catch (err) {
    console.error("admission document read error:", err);
    return res.status(500).json({ success: false, message: "Failed to load document" });
  }
});

/**
 * GET /api/admissions/online/mine
 * Latest online admission for the logged-in student.
 */
router.get("/online/mine", requireStudentJwt, async (req, res) => {
  try {
    const email = String(req.student?.email || "")
      .toLowerCase()
      .trim();
    if (!email) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid student session" });
    }

    const entry = await Admission.findOne({
      email,
      mode: "Online",
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!entry) {
      return res.json({ success: true, entry: null });
    }

    return res.json({ success: true, entry: toRow(entry) });
  } catch (err) {
    console.error("online admission mine error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to load online admission",
    });
  }
});

/**
 * GET /api/admissions/online/approved
 * All Approved admissions for the logged-in student (shown as enrolled courses).
 */
router.get("/online/approved", requireStudentJwt, async (req, res) => {
  try {
    const email = String(req.student?.email || "")
      .toLowerCase()
      .trim();
    if (!email) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid student session" });
    }

    const admissions = await Admission.find({
      email,
      status: "Approved",
    })
      .sort({ admissionDate: -1, createdAt: -1 })
      .lean()
      .maxTimeMS(8000);

    const courseIds = [
      ...new Set(
        admissions
          .map((row) => {
            const id = row?.details?.courseId;
            return mongoose.isValidObjectId(id) ? String(id) : null;
          })
          .filter(Boolean)
      ),
    ];

    const courseDocs =
      courseIds.length > 0
        ? await Course.find({
            _id: { $in: courseIds },
            softDelete: false,
          })
            .select(
              "name code durationLabel semesterCount category universityName universityShortName type"
            )
            .lean()
            .maxTimeMS(8000)
        : [];

    const courseById = new Map(
      courseDocs.map((doc) => [String(doc._id), doc])
    );

    const rows = admissions.map((entry) => {
      const base = toRow(entry);
      const details =
        base.details && typeof base.details === "object" ? base.details : {};
      const courseDoc = details.courseId
        ? courseById.get(String(details.courseId))
        : null;

      const duration =
        String(details.courseDuration || "").trim() ||
        courseDoc?.durationLabel ||
        "";
      const universityName =
        String(details.universityName || "").trim() ||
        courseDoc?.universityName ||
        base.college ||
        "";
      const semesterCount = Number(
        courseDoc?.semesterCount ?? details.semesterCount ?? 0
      );

      return {
        ...base,
        title: base.course,
        duration,
        universityName,
        universityShortName:
          String(details.universityShortName || "").trim() ||
          courseDoc?.universityShortName ||
          "",
        category: courseDoc?.category || details.category || "",
        semesterCount: Number.isFinite(semesterCount) ? semesterCount : 0,
        courseCode:
          String(details.courseCode || "").trim() || courseDoc?.code || "",
      };
    });

    return res.json({
      success: true,
      rows,
      total: rows.length,
    });
  } catch (err) {
    console.error("online admission approved error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to load approved courses",
    });
  }
});

/**
 * GET /api/admissions/catalog
 * Public catalog for student online admission — live universities & courses.
 */
router.get("/catalog", async (_req, res) => {
  try {
    const data = await buildAdmissionCatalog();
    return res.json({
      success: true,
      message: "Admission catalog fetched",
      universities: data.universities,
      totalCourses: data.totalCourses,
    });
  } catch (err) {
    console.error("admission catalog error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to load universities and courses",
    });
  }
});

/**
 * POST /api/admissions/online
 * Student portal online admission application.
 * Auth: student JWT
 * Forces mode=Online, status=Pending
 */
router.post("/online", requireStudentJwt, async (req, res) => {
  let idempotency = null;
  try {
    const email = String(req.student?.email || "")
      .toLowerCase()
      .trim();

    if (email) {
      const existingOpen = await Admission.findOne({
        email,
        mode: "Online",
        status: { $in: ["Pending", "Verification"] },
      })
        .sort({ createdAt: -1 })
        .lean();

      if (existingOpen) {
        return res.status(409).json({
          success: false,
          message:
            "You already have an online application under review. Please wait for admin approval.",
          entry: toRow(existingOpen),
        });
      }
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const payload = normalizePayload({
      ...body,
      mode: "Online",
      status: "Pending",
      ...(email ? { email } : {}),
    });

    const validationErrors = validatePayload(payload, { requireCourse: true });
    if (Object.keys(validationErrors).length) {
      return validationResponse(res, validationErrors);
    }

    const authoritative = await resolveAuthoritativeCourse(payload);
    if (authoritative.errors) return validationResponse(res, authoritative.errors);
    const authoritativePayload = authoritative.payload;

    const duplicate = await findDuplicateAdmission(authoritativePayload);
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "A matching admission already exists",
        errors: duplicateErrors(duplicate, authoritativePayload),
        entry: toRow(duplicate),
      });
    }

    const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();
    const claimed = await claimIdempotency(idempotencyKey, authoritativePayload);
    idempotency = claimed.record;
    if (claimed.replay) {
      return res.status(200).json({
        success: true,
        message: "Online admission application already submitted",
        entry: claimed.replay,
      });
    }

    const admissionDate =
      body.admissionDate != null && String(body.admissionDate).trim()
        ? new Date(body.admissionDate)
        : new Date();
    if (Number.isNaN(admissionDate.getTime())) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid admission date" });
    }

    const details =
      payload.details && typeof payload.details === "object"
        ? {
            ...payload.details,
            source: "student-online",
            submittedByEmail: email || "",
          }
        : {
            source: "student-online",
            submittedByEmail: email || "",
          };

    authoritativePayload.details = details;
    const created = await createAdmissionWithFee(
      { ...authoritativePayload, mode: "Online", status: "Pending" },
      admissionDate,
      email || "student"
    );
    const entry = toRow(created);
    await completeIdempotency(idempotency, entry);

    return res.status(201).json({
      success: true,
      message: "Online admission application submitted",
      entry,
    });
  } catch (err) {
    await releaseIdempotency(idempotency).catch(() => {});
    console.error("online admission create error:", err);
    if (err?.status === 409 || err?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: err.message || "Duplicate admission — please review the existing record",
      });
    }
    if (/transaction|replica set|mongos/i.test(String(err?.message || ""))) {
      return res.status(503).json({ success: false, message: "Admission service is temporarily unavailable. Please retry." });
    }
    return res.status(500).json({
      success: false,
      message: "Failed to submit online admission. No admission was saved.",
    });
  }
});

router.use(requireMasterAdminJwt);

router.get("/meta", (_req, res) => {
  return res.json({
    success: true,
    courses: TRAINING_COURSES,
    modes: ADMISSION_MODES,
    statuses: ADMISSION_STATUSES,
  });
});

/** Same shape used by universities.service.js / faculty.service.js. */
async function computeAdmissionStats(matchQuery) {
  const [byStatus, online, onlinePending] = await Promise.all([
    Admission.aggregate([{ $match: matchQuery }, { $group: { _id: "$status", count: { $sum: 1 } } }]).option({
      maxTimeMS: 8000,
    }),
    Admission.countDocuments({ ...matchQuery, mode: "Online" }).maxTimeMS(8000),
    Admission.countDocuments({
      ...matchQuery,
      mode: "Online",
      status: { $in: ["Pending", "Verification"] },
    }).maxTimeMS(8000),
  ]);
  const byStatusMap = Object.fromEntries(byStatus.map((row) => [row._id, row.count]));
  return {
    total: byStatus.reduce((sum, row) => sum + row.count, 0),
    pending: byStatusMap.Pending || 0,
    approved: byStatusMap.Approved || 0,
    verification: byStatusMap.Verification || 0,
    rejected: byStatusMap.Rejected || 0,
    online,
    onlinePending,
  };
}

/**
 * page/limit are additive — GET /api/admissions with neither is what
 * masterAdminNotifications.js and IdCardGeneratePage.jsx already call today,
 * expecting the complete list back in `rows`. Only the Admissions screen
 * itself sends both, for a real server-side page.
 */
router.get("/", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();
    const archivedOnly = String(req.query.archived || "") === "true";

    const mode = String(req.query.mode || "").trim();

    const query = { softDelete: archivedOnly ? true : false };
    if (status && ADMISSION_STATUSES.includes(status)) query.status = status;
    if (mode && ADMISSION_MODES.includes(mode)) query.mode = mode;

    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      query.$or = [
        { admissionId: rx },
        { applicant: rx },
        { email: rx },
        { phone: rx },
        { course: rx },
        { normalizedRegistrationNo: rx },
      ];
    }

    const page = req.query.page != null || req.query.limit != null ? Math.max(1, Number(req.query.page) || 1) : null;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    // slimDetails() (toListRow) is the real safety net for base64/document
    // payloads inside the Mixed `details` blob — it strips any data: URL and
    // known heavy keys generically. This projection just avoids shipping the
    // one field guaranteed to be huge over the wire before that runs.
    let cursor = Admission.find(query)
      .select("-details.photoPreview")
      .sort({ admissionDate: -1, createdAt: -1 });
    if (page != null) cursor = cursor.skip((page - 1) * limit).limit(limit);

    const [total, docs, stats] = await Promise.all([
      Admission.countDocuments(query).maxTimeMS(8000),
      cursor.lean().maxTimeMS(12000),
      // Stats intentionally reflect all non-archived admissions regardless of
      // the current search/status filter — same as before this change, when
      // there was no server-side filter at all and stats always covered
      // every row returned.
      computeAdmissionStats({ softDelete: archivedOnly ? true : false }),
    ]);

    return res.json({
      success: true,
      rows: docs.map(toListRow),
      stats,
      pagination:
        page != null
          ? { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
          : { page: 1, limit: total, total, totalPages: 1 },
    });
  } catch (err) {
    console.error("admissions list error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch admissions" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid admission id" });
    }
    const entry = await Admission.findById(id).lean();
    if (!entry) {
      return res.status(404).json({ success: false, message: "Admission not found" });
    }
    return res.json({ success: true, entry: toRow(entry) });
  } catch (err) {
    console.error("admission get error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch admission" });
  }
});

router.post("/", async (req, res) => {
  let idempotency = null;
  try {
    const payload = normalizePayload(req.body);
    const validationErrors = validatePayload(payload, { requireCourse: true });
    if (Object.keys(validationErrors).length) {
      return validationResponse(res, validationErrors);
    }

    const authoritative = await resolveAuthoritativeCourse(payload);
    if (authoritative.errors) return validationResponse(res, authoritative.errors);
    const authoritativePayload = authoritative.payload;

    const duplicate = await findDuplicateAdmission(authoritativePayload);
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "A matching admission already exists",
        errors: duplicateErrors(duplicate, authoritativePayload),
      });
    }

    const admissionDate =
      req.body?.admissionDate != null && String(req.body.admissionDate).trim()
        ? new Date(req.body.admissionDate)
        : new Date();
    if (Number.isNaN(admissionDate.getTime())) {
      return validationResponse(res, { admissionDate: "Invalid admission date" });
    }

    const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();
    const claimed = await claimIdempotency(idempotencyKey, {
      ...authoritativePayload,
      admissionDate,
    });
    idempotency = claimed.record;
    if (claimed.replay) {
      return res.status(200).json({
        success: true,
        message: "Admission already created",
        entry: claimed.replay,
      });
    }

    const created = await createAdmissionWithFee(
      authoritativePayload,
      admissionDate,
      req.masterAdmin?.email || "master-admin"
    );
    const entry = toRow(created);
    await completeIdempotency(idempotency, entry);

    return res.status(201).json({
      success: true,
      message: "Admission created successfully",
      entry,
    });
  } catch (err) {
    await releaseIdempotency(idempotency).catch(() => {});
    console.error("admission create error:", err);
    if (err?.status === 409 || err?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: err.message || "Duplicate admission — please review the existing record",
      });
    }
    if (/transaction|replica set|mongos/i.test(String(err?.message || ""))) {
      return res.status(503).json({ success: false, message: "Admission service is temporarily unavailable. Please retry." });
    }
    await cleanupTemporaryDocuments(req.body?.details).catch((cleanupErr) => {
      console.error("admission temporary document cleanup failed:", cleanupErr?.message || cleanupErr);
    });
    return res.status(500).json({ success: false, message: "Failed to create admission. No admission was saved." });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid admission id" });
    }

    // Archived admissions aren't editable through the normal edit flow —
    // restore first (PATCH /:id/restore), matching Universities' pattern of
    // scoping update/activate queries by softDelete.
    const existing = await Admission.findOne({ _id: id, softDelete: false }).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Admission not found" });
    }
    const previousStatus = existing.status;

    const payload = normalizePayload(req.body);
    const validationErrors = validatePayload(payload, { requireCourse: false });
    if (Object.keys(validationErrors).length) {
      return validationResponse(res, validationErrors);
    }

    const update = { ...payload, updatedBy: req.masterAdmin?.email || "master-admin" };
    if (req.body?.admissionDate != null && String(req.body.admissionDate).trim()) {
      const d = new Date(req.body.admissionDate);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid admission date" });
      }
      update.admissionDate = d;
    }

    const updated = await Admission.findOneAndUpdate({ _id: id, softDelete: false }, update, {
      new: true,
      runValidators: true,
    });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Admission not found" });
    }

    if (
      (updated.status === "Approved" || updated.status === "Rejected") &&
      updated.status !== previousStatus
    ) {
      notifyAdmissionStatusChange(updated, previousStatus).catch((e) =>
        console.error("admission notification failed:", e)
      );
    }

    try {
      await upsertFeeFromAdmission(updated);
    } catch (feeErr) {
      console.error("admission fee sync failed:", feeErr?.message || feeErr);
    }

    return res.json({
      success: true,
      message: "Admission updated",
      entry: toRow(updated),
    });
  } catch (err) {
    console.error("admission update error:", err);
    return res.status(500).json({ success: false, message: "Failed to update admission" });
  }
});

/**
 * Soft archive only — the admission, its fee history and its documents all
 * stay in the database exactly as they were. Nothing is cascade-deleted.
 * (Previously this was a hard findByIdAndDelete(); switched to match the
 * softDelete convention every other master-data module — University, Course
 * — already uses.)
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid admission id" });
    }
    const archived = await Admission.findOneAndUpdate(
      { _id: id, softDelete: false },
      { softDelete: true, updatedBy: req.masterAdmin?.email || "master-admin" },
      { new: true }
    );
    if (!archived) {
      return res.status(404).json({ success: false, message: "Admission not found" });
    }
    return res.json({
      success: true,
      message: "Admission archived (kept in database)",
      // toListRow, not toRow — same reason the list endpoint uses it: skip
      // shipping this admission's base64 photo/document payload back down
      // for a response the frontend only uses to refresh table state.
      entry: toListRow(archived),
    });
  } catch (err) {
    console.error("admission archive error:", err);
    return res.status(500).json({ success: false, message: "Failed to archive admission" });
  }
});

router.patch("/:id/restore", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid admission id" });
    }
    const restored = await Admission.findOneAndUpdate(
      { _id: id, softDelete: true },
      { softDelete: false, updatedBy: req.masterAdmin?.email || "master-admin" },
      { new: true }
    );
    if (!restored) {
      return res.status(404).json({ success: false, message: "Archived admission not found" });
    }
    return res.json({
      success: true,
      message: "Admission restored",
      entry: toListRow(restored),
    });
  } catch (err) {
    console.error("admission restore error:", err);
    return res.status(500).json({ success: false, message: "Failed to restore admission" });
  }
});

export default router;
