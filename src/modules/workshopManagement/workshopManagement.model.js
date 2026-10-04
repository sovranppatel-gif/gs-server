import mongoose from "mongoose";

/**
 * Workshop Management collections.
 *
 * All of these are NEW collections. The existing `workshopregistrations`
 * collection (WorkshopRegistration in ../workshop/workshop.model.js) stays the
 * single source of truth for students — everything here references it by
 * `registration` (ObjectId) + `registrationId` (the human GST-W-000001 id) and
 * never writes back to it.
 */

const { ObjectId } = mongoose.Schema.Types;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_STATUSES = ["Scheduled", "Live", "Completed", "Cancelled"];

const workshopSessionSchema = new mongoose.Schema(
  {
    dayNumber: { type: Number, required: true, min: 1, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    // YYYY-MM-DD, same string format the referral links already use
    date: { type: String, required: true, trim: true, index: true },
    startTime: { type: String, default: "", trim: true }, // HH:mm
    endTime: { type: String, default: "", trim: true },
    trainer: { type: String, default: "", trim: true },
    meetingLink: { type: String, default: "", trim: true },
    status: { type: String, enum: SESSION_STATUSES, default: "Scheduled", index: true },
    attendanceEnabled: { type: Boolean, default: true },
    reminderEnabled: { type: Boolean, default: true },
    // Public URL segment: /workshop/attendance/:slug (e.g. "day1")
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    createdBy: { type: String, default: "master-admin", trim: true },
  },
  { timestamps: true, versionKey: false }
);

export const WorkshopSession = mongoose.model(
  "WorkshopSession",
  workshopSessionSchema,
  "workshopsessions"
);

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export const ATTENDANCE_STATUSES = ["Present", "Absent"];

const attendanceChangeSchema = new mongoose.Schema(
  {
    admin: { type: String, default: "" },
    at: { type: Date, default: Date.now },
    previousStatus: { type: String, default: "Not Marked" },
    newStatus: { type: String, required: true },
    note: { type: String, default: "" },
  },
  { _id: false }
);

const workshopAttendanceSchema = new mongoose.Schema(
  {
    sessionId: { type: ObjectId, ref: "WorkshopSession", required: true, index: true },
    registration: { type: ObjectId, ref: "WorkshopRegistration", required: true, index: true },
    registrationId: { type: String, required: true, trim: true, index: true },
    status: { type: String, enum: ATTENDANCE_STATUSES, default: "Present", index: true },
    markedAt: { type: Date, default: Date.now },
    // "self" for the public page, otherwise the admin's email
    markedBy: { type: String, default: "self", trim: true },
    // registrationId+mobile4 | email+mobile4 | admin
    verificationMethod: { type: String, default: "", trim: true },
    history: { type: [attendanceChangeSchema], default: [] },
  },
  { timestamps: true, versionKey: false }
);

// One attendance row per student per session — the core duplicate guard.
workshopAttendanceSchema.index({ sessionId: 1, registrationId: 1 }, { unique: true });

export const WorkshopAttendance = mongoose.model(
  "WorkshopAttendance",
  workshopAttendanceSchema,
  "workshopattendances"
);

// ---------------------------------------------------------------------------
// Tasks & submissions
// ---------------------------------------------------------------------------

export const TASK_SUBMISSION_TYPES = ["URL", "GitHub URL", "LinkedIn URL", "Text", "None"];
export const TASK_STATUSES = ["Draft", "Active", "Closed"];
export const SUBMISSION_STATUSES = ["Submitted", "Reviewed", "Rejected"];

const workshopTaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    sessionId: { type: ObjectId, ref: "WorkshopSession", default: null, index: true },
    deadline: { type: String, default: "", trim: true }, // YYYY-MM-DD
    submissionType: { type: String, enum: TASK_SUBMISSION_TYPES, default: "URL" },
    status: { type: String, enum: TASK_STATUSES, default: "Active", index: true },
    createdBy: { type: String, default: "master-admin", trim: true },
  },
  { timestamps: true, versionKey: false }
);

export const WorkshopTask = mongoose.model("WorkshopTask", workshopTaskSchema, "workshoptasks");

const workshopTaskSubmissionSchema = new mongoose.Schema(
  {
    taskId: { type: ObjectId, ref: "WorkshopTask", required: true, index: true },
    registration: { type: ObjectId, ref: "WorkshopRegistration", required: true, index: true },
    registrationId: { type: String, required: true, trim: true, index: true },
    content: { type: String, default: "", trim: true },
    status: { type: String, enum: SUBMISSION_STATUSES, default: "Submitted", index: true },
    reviewNote: { type: String, default: "", trim: true },
    reviewedBy: { type: String, default: "", trim: true },
    reviewedAt: { type: Date, default: null },
    submittedBy: { type: String, default: "self", trim: true },
  },
  { timestamps: true, versionKey: false }
);

workshopTaskSubmissionSchema.index({ taskId: 1, registrationId: 1 }, { unique: true });

export const WorkshopTaskSubmission = mongoose.model(
  "WorkshopTaskSubmission",
  workshopTaskSubmissionSchema,
  "workshoptasksubmissions"
);

// ---------------------------------------------------------------------------
// WhatsApp messages
// ---------------------------------------------------------------------------

/**
 * Per-recipient status follows what Meta actually reports:
 *   queued   → not yet handed to the API
 *   accepted → API returned a message id (NOT a delivery confirmation)
 *   sent / delivered / read → only from the status webhook
 *   failed   → API or webhook reported an error
 *   skipped  → no usable phone number
 */
export const WA_RECIPIENT_STATUSES = [
  "queued",
  "accepted",
  "sent",
  "delivered",
  "read",
  "failed",
  "skipped",
];

const waRecipientSchema = new mongoose.Schema(
  {
    registration: { type: ObjectId, ref: "WorkshopRegistration", default: null },
    registrationId: { type: String, default: "" },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    renderedText: { type: String, default: "" },
    // Values for an approved template's {{1}}, {{2}}… captured at creation time
    params: { type: [String], default: [] },
    status: { type: String, enum: WA_RECIPIENT_STATUSES, default: "queued" },
    waMessageId: { type: String, default: "" },
    error: { type: String, default: "" },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const workshopWhatsappMessageSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["reminder", "announcement"], default: "reminder", index: true },
    category: { type: String, default: "", trim: true },
    title: { type: String, default: "", trim: true },
    body: { type: String, required: true },
    audience: { type: Object, default: {} },
    sessionId: { type: ObjectId, ref: "WorkshopSession", default: null },
    recipients: { type: [waRecipientSchema], default: [] },
    // queued | processing | completed | completed_with_errors | not_configured
    status: { type: String, default: "queued", index: true },
    createdBy: { type: String, default: "master-admin", trim: true },
  },
  { timestamps: true, versionKey: false }
);

workshopWhatsappMessageSchema.index({ "recipients.waMessageId": 1 });

export const WorkshopWhatsappMessage = mongoose.model(
  "WorkshopWhatsappMessage",
  workshopWhatsappMessageSchema,
  "workshopwhatsappmessages"
);

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

const workshopCertificateSchema = new mongoose.Schema(
  {
    certificateNumber: { type: String, required: true, unique: true, trim: true },
    registration: { type: ObjectId, ref: "WorkshopRegistration", required: true },
    registrationId: { type: String, required: true, unique: true, trim: true },
    studentName: { type: String, required: true, trim: true },
    collegeName: { type: String, default: "", trim: true },
    workshopName: { type: String, default: "", trim: true },
    attendancePercent: { type: Number, default: 0 },
    tasksCompleted: { type: Number, default: 0 },
    issuedAt: { type: Date, default: Date.now },
    issuedBy: { type: String, default: "master-admin", trim: true },
    status: { type: String, enum: ["Issued", "Revoked"], default: "Issued" },
  },
  { timestamps: true, versionKey: false }
);

export const WorkshopCertificate = mongoose.model(
  "WorkshopCertificate",
  workshopCertificateSchema,
  "workshopcertificates"
);

// ---------------------------------------------------------------------------
// Settings (single document, key "default")
// ---------------------------------------------------------------------------

const messageTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    body: { type: String, required: true },
  },
  { _id: true }
);

const workshopSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "default" },
    workshopName: { type: String, default: "Skills Enhance Workshop", trim: true },
    startDate: { type: String, default: "", trim: true },
    endDate: { type: String, default: "", trim: true },
    defaultStartTime: { type: String, default: "13:00", trim: true },
    defaultEndTime: { type: String, default: "15:00", trim: true },
    attendanceRequirementPercent: { type: Number, default: 75, min: 0, max: 100 },
    certificateRequireAllTasks: { type: Boolean, default: false },
    certificatesEnabled: { type: Boolean, default: false },
    restrictAttendanceToSessionDate: { type: Boolean, default: true },
    publicBaseUrl: { type: String, default: "", trim: true },
    whatsapp: {
      enabled: { type: Boolean, default: false },
      // "text" works only inside Meta's 24h customer-service window;
      // "template" uses an approved template for business-initiated messages.
      sendMode: { type: String, enum: ["text", "template"], default: "template" },
      templateName: { type: String, default: "", trim: true },
      templateLanguage: { type: String, default: "en", trim: true },
      // Ordered variable names mapped to the template's {{1}}, {{2}}, ...
      templateParams: { type: [String], default: [] },
    },
    messageTemplates: { type: [messageTemplateSchema], default: [] },
    updatedBy: { type: String, default: "", trim: true },
  },
  { timestamps: true, versionKey: false }
);

export const WorkshopSettings = mongoose.model(
  "WorkshopSettings",
  workshopSettingsSchema,
  "workshopsettings"
);

// ---------------------------------------------------------------------------
// Rate limiting for the public endpoints. Stored in Mongo (not memory) because
// the API runs on Vercel serverless, where in-memory counters reset per
// instance. Documents auto-expire via the TTL index.
// ---------------------------------------------------------------------------

const workshopRateLimitSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

workshopRateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const WorkshopRateLimit = mongoose.model(
  "WorkshopRateLimit",
  workshopRateLimitSchema,
  "workshopratelimits"
);

/**
 * The unique indexes are the real duplicate guards (one attendance per
 * student per session, one submission per student per task). Mongoose builds
 * indexes in the background, so writes await this once per process to make
 * sure they exist before the first insert. createIndexes() is idempotent and
 * only touches these new collections.
 */
let indexesReady = null;
export function ensureWorkshopIndexes() {
  if (!indexesReady) {
    indexesReady = Promise.all([
      WorkshopAttendance.createIndexes(),
      WorkshopTaskSubmission.createIndexes(),
      WorkshopCertificate.createIndexes(),
    ]).catch((err) => {
      indexesReady = null;
      throw err;
    });
  }
  return indexesReady;
}
