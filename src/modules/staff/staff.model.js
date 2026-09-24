import mongoose from "mongoose";

export const STAFF_STATUSES = [
  "Active",
  "Probation",
  "Notice Period",
  "Resigned",
  "Relieved",
  "Archived",
];
export const EMPLOYMENT_TYPES = ["Full Time", "Part Time", "Contract", "Intern", "Consultant", "Temporary"];
export const WORK_MODES = ["Office", "Remote", "Hybrid"];
export const STAFF_GENDERS = ["Male", "Female", "Other"];
export const EMPLOYMENT_HISTORY_TYPES = [
  "Joining",
  "Probation",
  "Confirmation",
  "Promotion",
  "Department Transfer",
  "Designation Change",
  "Status Change",
];

const personalDetailsSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    middleName: { type: String, default: "", trim: true },
    lastName: { type: String, default: "", trim: true },
    fullName: { type: String, required: true, trim: true },
    profilePhoto: { type: String, default: "", trim: true },
    parentName: { type: String, default: "", trim: true },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, enum: STAFF_GENDERS, default: "Male" },
    bloodGroup: { type: String, default: "", trim: true },
    personalMobile: { type: String, required: true, trim: true },
    whatsapp: { type: String, default: "", trim: true },
    personalEmail: { type: String, default: "", trim: true, lowercase: true },
    officialEmail: { type: String, required: true, trim: true, lowercase: true },
    alternateContact: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    city: { type: String, default: "", trim: true },
    state: { type: String, default: "", trim: true },
    pincode: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const emergencyContactSchema = new mongoose.Schema(
  {
    name: { type: String, default: "", trim: true },
    relationship: { type: String, default: "", trim: true },
    phone: { type: String, default: "", trim: true },
    alternatePhone: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const employmentDetailsSchema = new mongoose.Schema(
  {
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: "StaffDepartment", default: null },
    departmentName: { type: String, default: "", trim: true },
    designationId: { type: mongoose.Schema.Types.ObjectId, ref: "StaffDesignation", default: null },
    designationName: { type: String, default: "", trim: true },
    reportingManagerId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
    reportingManagerName: { type: String, default: "", trim: true },
    branch: { type: String, default: "", trim: true },
    joiningDate: { type: Date, required: true },
    employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: "Full Time" },
    workMode: { type: String, enum: WORK_MODES, default: "Office" },
    probationPeriodMonths: { type: Number, default: 0, min: 0 },
    probationEndDate: { type: Date, default: null },
    confirmationDate: { type: Date, default: null },
    shift: { type: String, default: "", trim: true },
    weeklyWorkingDays: { type: Number, default: 6, min: 0, max: 7 },
  },
  { _id: false }
);

const accountDetailsSchema = new mongoose.Schema(
  {
    loginEnabled: { type: Boolean, default: false },
    username: { type: String, default: "", trim: true, lowercase: true },
    // bcrypt hash only. Never store or return the plain password — same rule
    // as Faculty's accountDetails.passwordHash.
    passwordHash: { type: String, default: "", select: false },
    role: { type: String, default: "Staff", trim: true },
    permissions: { type: [String], default: [] },
    lastLogin: { type: Date, default: null },
  },
  { _id: false }
);

// Restricted-access sections — select: false so a plain .find()/.findOne()
// never returns them; the service layer opts in with .select("+salaryDetails")
// / .select("+bankDetails") only where that's explicitly intended (never in
// the staff list).
const salaryDetailsSchema = new mongoose.Schema(
  {
    monthlySalary: { type: Number, default: 0, min: 0 },
    basic: { type: Number, default: 0, min: 0 },
    hra: { type: Number, default: 0, min: 0 },
    allowances: { type: Number, default: 0, min: 0 },
    incentives: { type: Number, default: 0, min: 0 },
    variablePay: { type: Number, default: 0, min: 0 },
    deductions: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const bankDetailsSchema = new mongoose.Schema(
  {
    bankName: { type: String, default: "", trim: true },
    accountHolderName: { type: String, default: "", trim: true },
    accountNumber: { type: String, default: "", trim: true },
    ifsc: { type: String, default: "", trim: true, uppercase: true },
    branch: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const employmentHistorySchema = new mongoose.Schema(
  {
    date: { type: Date, default: Date.now },
    type: { type: String, enum: EMPLOYMENT_HISTORY_TYPES, required: true },
    description: { type: String, required: true, trim: true },
    actor: { type: String, default: "master-admin", trim: true },
  },
  { _id: false }
);

const offboardingSchema = new mongoose.Schema(
  {
    resignationDate: { type: Date, default: null },
    noticePeriodDays: { type: Number, default: 0, min: 0 },
    lastWorkingDate: { type: Date, default: null },
    reason: { type: String, default: "", trim: true },
    exitInterviewNotes: { type: String, default: "", trim: true },
    handoverStatus: { type: String, default: "", trim: true },
    assetReturnStatus: { type: String, default: "", trim: true },
    finalSettlementStatus: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const staffSchema = new mongoose.Schema(
  {
    employeeId: { type: String, required: true, unique: true, trim: true },
    personalDetails: { type: personalDetailsSchema, required: true },
    emergencyContact: { type: emergencyContactSchema, default: () => ({}) },
    employmentDetails: { type: employmentDetailsSchema, required: true },
    accountDetails: { type: accountDetailsSchema, default: () => ({}) },
    salaryDetails: { type: salaryDetailsSchema, default: () => ({}), select: false },
    bankDetails: { type: bankDetailsSchema, default: () => ({}), select: false },
    employmentHistory: { type: [employmentHistorySchema], default: [] },
    offboarding: { type: offboardingSchema, default: () => ({}) },
    status: { type: String, enum: STAFF_STATUSES, default: "Active", index: true },
    softDelete: { type: Boolean, default: false, index: true },
    createdBy: { type: String, default: "master-admin", trim: true },
    updatedBy: { type: String, default: "master-admin", trim: true },
  },
  { timestamps: true, versionKey: false }
);

staffSchema.index({ softDelete: 1, status: 1, createdAt: -1 });
staffSchema.index({ softDelete: 1, "employmentDetails.departmentId": 1 });
staffSchema.index({ softDelete: 1, "employmentDetails.designationId": 1 });
staffSchema.index({ softDelete: 1, "employmentDetails.branch": 1 });
staffSchema.index({ softDelete: 1, "employmentDetails.joiningDate": -1 });
staffSchema.index({ "personalDetails.personalMobile": 1 });
staffSchema.index(
  { "personalDetails.officialEmail": 1 },
  { unique: true, partialFilterExpression: { softDelete: false } }
);
staffSchema.index(
  { "accountDetails.username": 1 },
  { unique: true, partialFilterExpression: { "accountDetails.username": { $type: "string", $gt: "" } } }
);

export const Staff = mongoose.model("Staff", staffSchema);
