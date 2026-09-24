import mongoose from "mongoose";

const admissionDocumentSchema = new mongoose.Schema(
  {
    storageName: { type: String, required: true, unique: true, trim: true },
    originalName: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    size: { type: Number, required: true, min: 0 },
    uploadedByType: {
      type: String,
      enum: ["master-admin", "student"],
      required: true,
    },
    uploadedByEmail: { type: String, default: "", trim: true, lowercase: true },
    admissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admission",
      default: null,
      index: true,
    },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true, versionKey: false }
);

admissionDocumentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdmissionDocument = mongoose.model(
  "AdmissionDocument",
  admissionDocumentSchema
);