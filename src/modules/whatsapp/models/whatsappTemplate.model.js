import mongoose from "mongoose";

export const WA_TEMPLATE_CATEGORIES = Object.freeze(["MARKETING", "UTILITY", "AUTHENTICATION"]);
export const WA_TEMPLATE_STATUSES = Object.freeze(["DRAFT", "PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED"]);

/**
 * source "meta"  → synced from / submitted to Meta; status mirrors Meta's review.
 * source "local" → a local draft. Drafts can never be sent outside the 24h
 * customer-service window (live mode requires an APPROVED Meta template).
 */
const variableSchema = new mongoose.Schema(
  {
    index: { type: Number, required: true }, // {{1}}, {{2}}…
    label: { type: String, default: "", trim: true },
    sample: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const whatsappTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, lowercase: true },
    language: { type: String, default: "en", trim: true },
    category: { type: String, enum: WA_TEMPLATE_CATEGORIES, default: "UTILITY" },
    status: { type: String, enum: WA_TEMPLATE_STATUSES, default: "DRAFT" },
    source: { type: String, enum: ["local", "meta"], default: "local" },
    metaTemplateId: { type: String, default: "" },
    headerText: { type: String, default: "" },
    bodyText: { type: String, default: "" },
    footerText: { type: String, default: "" },
    buttons: { type: [mongoose.Schema.Types.Mixed], default: [] },
    components: { type: [mongoose.Schema.Types.Mixed], default: [] }, // raw Meta components
    variables: { type: [variableSchema], default: [] },
    rejectedReason: { type: String, default: "" },
    lastSyncedAt: { type: Date, default: null },
    createdBy: { type: String, default: "system", trim: true },
    updatedBy: { type: String, default: "system", trim: true },
  },
  { timestamps: true, versionKey: false }
);

whatsappTemplateSchema.index({ name: 1, language: 1 }, { unique: true });
whatsappTemplateSchema.index({ status: 1, updatedAt: -1 });

export const WhatsAppTemplate = mongoose.model("WhatsAppTemplate", whatsappTemplateSchema, "whatsapp_templates");
