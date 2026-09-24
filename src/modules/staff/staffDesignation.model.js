import mongoose from "mongoose";

const staffDesignationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, default: "", trim: true, uppercase: true },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: "StaffDepartment", default: null },
    departmentName: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    level: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active", index: true },
    softDelete: { type: Boolean, default: false, index: true },
    normalizedName: { type: String, default: "", select: false },
    createdBy: { type: String, default: "master-admin", trim: true },
    updatedBy: { type: String, default: "master-admin", trim: true },
  },
  { timestamps: true, versionKey: false }
);

staffDesignationSchema.index({ softDelete: 1, departmentId: 1, name: 1 });
// Unique per department, not globally — "Manager" can exist under both Sales
// and Operations.
staffDesignationSchema.index(
  { departmentId: 1, normalizedName: 1 },
  { unique: true, partialFilterExpression: { softDelete: false } }
);

export const StaffDesignation = mongoose.model("StaffDesignation", staffDesignationSchema);
