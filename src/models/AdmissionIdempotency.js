import mongoose from "mongoose";

const admissionIdempotencySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    requestHash: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["processing", "completed"],
      default: "processing",
      index: true,
    },
    admissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admission",
      default: null,
    },
    responseEntry: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, versionKey: false }
);

admissionIdempotencySchema.index(
  { updatedAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 }
);

export const AdmissionIdempotency = mongoose.model(
  "AdmissionIdempotency",
  admissionIdempotencySchema
);