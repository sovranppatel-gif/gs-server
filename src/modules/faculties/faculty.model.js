import mongoose from "mongoose";

export const FACULTY_STATUSES = ["Active", "Inactive"];
export const EMPLOYMENT_TYPES = ["Full Time", "Part Time", "Guest Faculty", "Contract"];
export const FACULTY_GENDERS = ["Male", "Female", "Other"];

const personalDetailsSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    profilePhoto: { type: String, default: "", trim: true },
    gender: { type: String, enum: FACULTY_GENDERS, default: "Male" },
    dateOfBirth: { type: Date, default: null },
    fatherOrHusbandName: { type: String, default: "", trim: true },
    mobile: { type: String, required: true, trim: true },
    alternateMobile: { type: String, default: "", trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    address: { type: String, default: "", trim: true },
    city: { type: String, default: "", trim: true },
    state: { type: String, default: "", trim: true },
    pincode: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const employmentDetailsSchema = new mongoose.Schema(
  {
    designation: { type: String, required: true, trim: true },
    department: { type: String, default: "", trim: true },
    qualification: { type: String, default: "", trim: true },
    specialization: { type: String, default: "", trim: true },
    experienceYears: { type: Number, default: 0, min: 0 },
    joiningDate: { type: Date, default: null },
    employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: "Full Time" },
  },
  { _id: false }
);

const accountDetailsSchema = new mongoose.Schema(
  {
    loginEnabled: { type: Boolean, default: false },
    username: { type: String, default: "", trim: true, lowercase: true },
    // bcrypt hash only. Never store or return the plain password.
    passwordHash: { type: String, default: "", select: false },
  },
  { _id: false }
);

const facultySchema = new mongoose.Schema(
  {
    facultyId: { type: String, required: true, unique: true, trim: true },
    personalDetails: { type: personalDetailsSchema, required: true },
    employmentDetails: { type: employmentDetailsSchema, required: true },
    accountDetails: { type: accountDetailsSchema, default: () => ({}) },
    status: { type: String, enum: FACULTY_STATUSES, default: "Active", index: true },
    permissions: { type: [String], default: [] },
    // Denormalized list of active course names for a fast list view — refreshed
    // whenever an assignment for this faculty is created/updated/removed
    // (same pattern as Batch.enrolledCount).
    assignedCourses: { type: [String], default: [] },
    softDelete: { type: Boolean, default: false, index: true },
    createdBy: { type: String, default: "master-admin", trim: true },
    updatedBy: { type: String, default: "master-admin", trim: true },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

facultySchema.index({ softDelete: 1, status: 1, createdAt: -1 });
facultySchema.index({ softDelete: 1, "employmentDetails.designation": 1 });
facultySchema.index({ softDelete: 1, "employmentDetails.department": 1 });
facultySchema.index({ "personalDetails.mobile": 1 });
facultySchema.index(
  { "personalDetails.email": 1 },
  { unique: true, partialFilterExpression: { softDelete: false } }
);
facultySchema.index(
  { "accountDetails.username": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "accountDetails.username": { $type: "string", $gt: "" },
    },
  }
);

export const Faculty = mongoose.model("Faculty", facultySchema);
