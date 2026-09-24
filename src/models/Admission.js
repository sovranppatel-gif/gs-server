import mongoose from "mongoose";

export const ADMISSION_MODES = ["Online", "Offline", "Walk-in"];
export const ADMISSION_STATUSES = [
  "Pending",
  "Verification",
  "Approved",
  "Rejected",
];

const admissionSchema = new mongoose.Schema(
  {
    admissionId: { type: String, required: true, unique: true, trim: true },
    applicant: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, required: true, trim: true },
    normalizedEmail: { type: String, default: "", trim: true },
    normalizedPhone: { type: String, default: "", trim: true },
    normalizedRegistrationNo: { type: String, default: "", trim: true },
    courseKey: { type: String, default: "", trim: true },
    sessionKey: { type: String, default: "", trim: true },
    course: { type: String, required: true, trim: true },
    mode: {
      type: String,
      enum: ADMISSION_MODES,
      default: "Online",
      trim: true,
    },
    counsellor: { type: String, default: "", trim: true },
    fee: { type: String, default: "₹5,000", trim: true },
    status: {
      type: String,
      enum: ADMISSION_STATUSES,
      default: "Pending",
      trim: true,
    },
    city: { type: String, default: "", trim: true },
    state: { type: String, default: "", trim: true },
    college: { type: String, default: "", trim: true },
    studentStatus: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    admissionDate: { type: Date, default: Date.now },
    createdBy: { type: String, default: "master-admin", trim: true },
    updatedBy: { type: String, default: "", trim: true },

    // Archive flag — separate from the workflow `status` above on purpose
    // (Pending/Verification/Approved/Rejected is business state; this is
    // deletion state). "Delete" from the Master Admin list sets this true
    // instead of removing the document, so fee/document/student records that
    // reference this admission by id never go stale. Same convention as
    // University/Course's softDelete.
    softDelete: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

admissionSchema.index({ admissionDate: -1 });
admissionSchema.index({ status: 1, admissionDate: -1 });
admissionSchema.index({ email: 1 });
admissionSchema.index({ course: 1 });
admissionSchema.index({ softDelete: 1, admissionDate: -1 });
admissionSchema.index({ softDelete: 1, status: 1 });
admissionSchema.index(
  { normalizedEmail: 1, courseKey: 1, sessionKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      normalizedEmail: { $type: "string", $ne: "" },
      courseKey: { $type: "string", $ne: "" },
      sessionKey: { $type: "string", $ne: "" },
      status: { $in: ["Pending", "Verification", "Approved"] },
    },
  }
);
admissionSchema.index(
  { normalizedPhone: 1, courseKey: 1, sessionKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      normalizedPhone: { $type: "string", $ne: "" },
      courseKey: { $type: "string", $ne: "" },
      sessionKey: { $type: "string", $ne: "" },
      status: { $in: ["Pending", "Verification", "Approved"] },
    },
  }
);
admissionSchema.index(
  { normalizedRegistrationNo: 1 },
  {
    unique: true,
    partialFilterExpression: {
      normalizedRegistrationNo: { $type: "string", $ne: "" },
    },
  }
);

export const Admission = mongoose.model("Admission", admissionSchema);
