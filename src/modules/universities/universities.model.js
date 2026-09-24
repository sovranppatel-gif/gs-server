import mongoose from "mongoose";

const universitySchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    shortName: { type: String, trim: true, required: true, uppercase: true },
    universityCode: { type: String, trim: true, default: "" },
    registrationNumber: { type: String, trim: true, required: true },
    affiliationNumber: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    contactPerson: { type: String, trim: true, default: "" },
    contactPhone: { type: String, trim: true, default: "" },
    contactEmail: { type: String, trim: true, lowercase: true, default: "" },
    website: { type: String, trim: true, default: "" },
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

    // Lowercased/whitespace-collapsed mirrors of shortName/registrationNumber,
    // kept in sync by universities.service.js on every create/update. Never
    // returned to the client (stripped in toRow) — they exist only so the
    // partial unique indexes below can catch "RDVV" vs " rdvv " vs "Rdvv" as
    // the same university without touching the admin's display formatting.
    shortNameNormalized: { type: String, trim: true, default: "", select: false },
    registrationNumberNormalized: { type: String, trim: true, default: "", select: false },
  },
  { timestamps: true }
);

universitySchema.index({ softDelete: 1, name: 1 });
universitySchema.index({ softDelete: 1, shortName: 1 });
universitySchema.index({ softDelete: 1, registrationNumber: 1 });

// Race-safe duplicate protection: enforced by MongoDB itself, not just an
// application-level findOne-then-create check, so two simultaneous "Add
// University" submissions can't both succeed. Scoped to softDelete: false —
// today nothing ever sets softDelete: true (Deactivate only flips status to
// "Inactive" and keeps the record live for history), so this is effectively
// "unique across every university that still exists", which is the intended
// rule: reusing an Inactive university's short name/registration number
// should reactivate that record, not spawn a second one with the same
// identity. The $gt: "" guard keeps a blank value (which required-field
// validation should never allow through anyway) from tripping the index.
universitySchema.index(
  { shortNameNormalized: 1 },
  { unique: true, partialFilterExpression: { softDelete: false, shortNameNormalized: { $gt: "" } } }
);
universitySchema.index(
  { registrationNumberNormalized: 1 },
  { unique: true, partialFilterExpression: { softDelete: false, registrationNumberNormalized: { $gt: "" } } }
);

export const University = mongoose.model("University", universitySchema);
