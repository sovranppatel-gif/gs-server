import mongoose from "mongoose";

const staffDepartmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, default: "", trim: true, uppercase: true },
    headName: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active", index: true },
    softDelete: { type: Boolean, default: false, index: true },
    createdBy: { type: String, default: "master-admin", trim: true },
    updatedBy: { type: String, default: "master-admin", trim: true },
  },
  { timestamps: true, versionKey: false }
);

staffDepartmentSchema.index({ softDelete: 1, name: 1 });
staffDepartmentSchema.index(
  { normalizedName: 1 },
  { unique: true, partialFilterExpression: { softDelete: false } }
);
// Stored alongside `name` (lowercased/trimmed by the service layer) purely
// for the uniqueness index above — never returned to the client.
staffDepartmentSchema.add({ normalizedName: { type: String, default: "", select: false } });

export const StaffDepartment = mongoose.model("StaffDepartment", staffDepartmentSchema);
