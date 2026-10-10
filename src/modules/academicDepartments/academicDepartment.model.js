import mongoose from "mongoose";

/**
 * Academic (teaching) departments — Computer Science, Commerce, Management…
 *
 * Deliberately separate from StaffDepartment (modules/staff), which models
 * non-teaching units like HR or Accounts. Faculty and Courses point here via
 * ObjectId; students/admissions are derived through their Course.
 */
export const ACADEMIC_DEPARTMENT_STATUSES = ["Active", "Inactive"];

const academicDepartmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    shortName: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    // Head of Department — must be a Faculty linked to this department
    // (enforced in the service layer, see assertValidHod).
    hod: { type: mongoose.Schema.Types.ObjectId, ref: "Faculty", default: null },
    email: { type: String, default: "", trim: true, lowercase: true },
    phone: { type: String, default: "", trim: true },
    status: { type: String, enum: ACADEMIC_DEPARTMENT_STATUSES, default: "Active" },
    establishedYear: { type: Number, default: null },
    capacity: { type: Number, default: null, min: 0 },
    softDelete: { type: Boolean, default: false },
    createdBy: { type: String, default: "master-admin", trim: true },
    updatedBy: { type: String, default: "master-admin", trim: true },
    // Lowercased, whitespace-collapsed `name`, maintained by the service layer
    // purely for the duplicate-name index below — never returned to clients.
    normalizedName: { type: String, default: "", select: false },
  },
  { timestamps: true, versionKey: false }
);

academicDepartmentSchema.index({ softDelete: 1, status: 1, name: 1 });
academicDepartmentSchema.index({ hod: 1 }, { partialFilterExpression: { hod: { $type: "objectId" } } });
academicDepartmentSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { softDelete: false } }
);
academicDepartmentSchema.index(
  { normalizedName: 1 },
  { unique: true, partialFilterExpression: { softDelete: false } }
);

export const AcademicDepartment = mongoose.model("AcademicDepartment", academicDepartmentSchema);
