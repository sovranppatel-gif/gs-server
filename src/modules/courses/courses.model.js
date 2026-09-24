import mongoose from "mongoose";

const subjectSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    code: { type: String, trim: true, default: "" },
    theoryHours: { type: Number, default: 0 },
    practicalHours: { type: Number, default: 0 },
    credits: { type: Number, default: 0 },
  },
  { _id: false }
);

const semesterSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, min: 1 },
    title: { type: String, trim: true, default: "" },
    durationMonths: { type: Number, default: 0 },
    description: { type: String, trim: true, default: "" },
    subjects: { type: [subjectSchema], default: [] },
  },
  { _id: false }
);

const feesSchema = new mongoose.Schema(
  {
    total: { type: String, trim: true, default: "" },
    registration: { type: String, trim: true, default: "" },
    exam: { type: String, trim: true, default: "" },
    installmentAllowed: { type: Boolean, default: true },
  },
  { _id: false }
);

const courseSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    code: { type: String, trim: true, default: "", index: true },
    type: {
      type: String,
      enum: ["University", "Institute"],
      default: "University",
      index: true,
    },
    universityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "University",
      default: null,
      index: true,
    },
    universityName: { type: String, trim: true, default: "" },
    universityShortName: { type: String, trim: true, uppercase: true, default: "" },
    category: {
      type: String,
      enum: ["Diploma", "Certificate", "Degree", "PG Diploma", "Training", "Other"],
      default: "Diploma",
    },
    durationMonths: { type: Number, default: 6, min: 0 },
    durationLabel: { type: String, trim: true, default: "" },
    semesterCount: { type: Number, default: 0, min: 0 },
    semesters: { type: [semesterSchema], default: [] },
    fees: { type: feesSchema, default: () => ({}) },
    eligibility: { type: String, trim: true, default: "" },
    mode: {
      type: String,
      enum: ["Offline", "Online", "Hybrid"],
      default: "Offline",
    },
    description: { type: String, trim: true, default: "" },
    highlights: { type: [String], default: [] },
    status: {
      type: String,
      enum: ["Active", "Inactive", "Draft"],
      default: "Active",
      index: true,
    },
    remarks: { type: String, trim: true, default: "" },
    createdBy: { type: String, trim: true, default: "system" },
    updatedBy: { type: String, trim: true, default: "system" },
    softDelete: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

courseSchema.index({ softDelete: 1, name: 1 });
courseSchema.index({ softDelete: 1, code: 1 });
courseSchema.index({ softDelete: 1, type: 1, status: 1 });
courseSchema.index({ softDelete: 1, universityId: 1 });

export const Course = mongoose.model("Course", courseSchema);
