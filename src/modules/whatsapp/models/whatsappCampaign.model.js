import mongoose from "mongoose";

export const WA_CAMPAIGN_STATUSES = Object.freeze([
  "Draft",
  "Scheduled",
  "Queued",
  "Running",
  "Paused",
  "Completed",
  "Cancelled",
  "Failed",
]);

/**
 * Recipients live in WhatsAppCampaignRecipient (one row each), so a campaign
 * document stays small regardless of audience size.
 */
const variableMappingSchema = new mongoose.Schema(
  {
    index: { type: Number, required: true },
    source: { type: String, enum: ["name", "phone", "course", "batch", "static"], default: "name" },
    value: { type: String, default: "" }, // static text / fallback
  },
  { _id: false }
);

const whatsappCampaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    kind: { type: String, enum: ["bulk", "scheduled"], default: "bulk" },
    status: { type: String, enum: WA_CAMPAIGN_STATUSES, default: "Draft" },
    audience: {
      source: { type: String, default: "" },
      filters: { type: mongoose.Schema.Types.Mixed, default: {} },
      summary: { type: String, default: "" },
    },
    template: {
      templateId: { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppTemplate", default: null },
      name: { type: String, default: "" },
      language: { type: String, default: "en" },
      status: { type: String, default: "" },
      source: { type: String, default: "" },
      bodyText: { type: String, default: "" },
      variableMapping: { type: [variableMappingSchema], default: [] },
    },
    scheduledAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    totals: {
      recipients: { type: Number, default: 0 },
      excludedDuplicates: { type: Number, default: 0 },
      excludedOptOut: { type: Number, default: 0 },
      excludedInvalid: { type: Number, default: 0 },
    },
    dryRun: { type: Boolean, default: true },
    lastError: { type: String, default: "" },
    createdBy: { type: String, default: "system", trim: true },
    updatedBy: { type: String, default: "system", trim: true },
  },
  { timestamps: true, versionKey: false, minimize: false }
);

whatsappCampaignSchema.index({ status: 1, scheduledAt: 1 });
whatsappCampaignSchema.index({ kind: 1, createdAt: -1 });
whatsappCampaignSchema.index({ createdAt: -1 });

export const WhatsAppCampaign = mongoose.model("WhatsAppCampaign", whatsappCampaignSchema, "whatsapp_campaigns");
