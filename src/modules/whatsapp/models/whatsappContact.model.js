import mongoose from "mongoose";

export const WA_CONSENT_STATUSES = Object.freeze(["unknown", "opted_in", "opted_out"]);
// Workshop registrations are intentionally not a source: that system stays independent.
export const WA_SOURCE_TYPES = Object.freeze(["lead", "student", "admission", "staff", "faculty", "enquiry"]);

/**
 * A WhatsApp identity. Business data stays in its own module — this only
 * keeps pointers (sourceReferences) to matching Lead/Admission/Staff/… records.
 */
const sourceReferenceSchema = new mongoose.Schema(
  {
    type: { type: String, enum: WA_SOURCE_TYPES, required: true },
    refId: { type: String, required: true },
    label: { type: String, default: "", trim: true },
    detail: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const whatsappContactSchema = new mongoose.Schema(
  {
    normalizedPhone: { type: String, required: true, trim: true },
    displayName: { type: String, default: "", trim: true },
    profileName: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    sourceReferences: { type: [sourceReferenceSchema], default: [] },
    resolvedAt: { type: Date, default: null },
    tags: { type: [String], default: [] },
    consentStatus: { type: String, enum: WA_CONSENT_STATUSES, default: "unknown" },
    optOut: { type: Boolean, default: false },
    optOutAt: { type: Date, default: null },
    optInAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    lastInboundAt: { type: Date, default: null },
    processingToken: { type: String, default: "" },
    processingUntil: { type: Date, default: null },
    notes: { type: String, default: "", trim: true },
    createdBy: { type: String, default: "system", trim: true },
    updatedBy: { type: String, default: "system", trim: true },
  },
  { timestamps: true, versionKey: false }
);

whatsappContactSchema.index({ normalizedPhone: 1 }, { unique: true });
whatsappContactSchema.index({ tags: 1 });
whatsappContactSchema.index({ optOut: 1 });
whatsappContactSchema.index({ updatedAt: -1 });
whatsappContactSchema.index({ "sourceReferences.type": 1 });

export const WhatsAppContact = mongoose.model("WhatsAppContact", whatsappContactSchema, "whatsapp_contacts");
