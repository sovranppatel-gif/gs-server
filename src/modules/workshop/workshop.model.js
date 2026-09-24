import mongoose from "mongoose";

const workshopRegistrationSchema = new mongoose.Schema(
  {
    registrationId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    mobile: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    universityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "University",
      default: null,
      index: true,
    },
    collegeName: {
      type: String,
      default: "",
      trim: true,
    },
    course: {
      type: String,
      required: true,
      trim: true,
    },
    semesterYear: {
      type: String,
      required: true,
      trim: true,
    },
    whatsappNumber: {
      type: String,
      default: "",
      trim: true,
    },
    githubProfile: {
      type: String,
      default: "",
      trim: true,
    },
    linkedinProfile: {
      type: String,
      default: "",
      trim: true,
    },
    codingExperience: {
      type: String,
      default: "",
      trim: true,
    },
    referralCode: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["Registered", "Verified", "Approved", "Rejected"],
      default: "Registered",
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Indexes for performance
workshopRegistrationSchema.index({ email: 1, mobile: 1 });
workshopRegistrationSchema.index({ referralCode: 1, createdAt: -1 });
workshopRegistrationSchema.index({ universityId: 1, createdAt: -1 });
workshopRegistrationSchema.index({ status: 1, createdAt: -1 });
workshopRegistrationSchema.index({ createdAt: -1 });

export const WorkshopRegistration = mongoose.model(
  "WorkshopRegistration",
  workshopRegistrationSchema,
  "workshopregistrations"
);

/**
 * Admin-created college referral links (e.g. COLLEGE_A) for the single
 * Skills Enhance Workshop public page. Lets the admin generate a shareable
 * /workshop?ref=CODE URL up front, before any student has registered with
 * that code yet, instead of the code only becoming visible once someone
 * submits the form.
 */
const workshopReferralLinkSchema = new mongoose.Schema(
  {
    referralCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    collegeName: {
      type: String,
      required: true,
      trim: true,
    },
    workshopName: {
      type: String,
      default: "Skills Enhance Workshop",
      trim: true,
    },
    workshopPlace: {
      type: String,
      default: "",
      trim: true,
    },
    workshopStartDate: {
      type: String,
      default: "",
      trim: true,
    },
    workshopEndDate: {
      type: String,
      default: "",
      trim: true,
    },
    startTime: {
      type: String,
      default: "",
      trim: true,
    },
    endTime: {
      type: String,
      default: "",
      trim: true,
    },
    createdBy: {
      type: String,
      default: "master-admin",
      trim: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

export const WorkshopReferralLink = mongoose.model(
  "WorkshopReferralLink",
  workshopReferralLinkSchema,
  "workshopreferrallinks"
);
