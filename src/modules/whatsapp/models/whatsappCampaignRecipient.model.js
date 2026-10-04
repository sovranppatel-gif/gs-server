import mongoose from "mongoose";

/** "Sent" means Meta accepted the message; Delivered/Read come from the webhook. */
export const WA_RECIPIENT_STATUSES = Object.freeze(["Pending", "Sent", "Delivered", "Read", "Failed", "Skipped"]);
export const WA_RECIPIENT_RANK = Object.freeze({ Pending: 0, Sent: 1, Delivered: 2, Read: 3 });

const whatsappCampaignRecipientSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppCampaign", required: true },
    phone: { type: String, required: true, trim: true },
    name: { type: String, default: "", trim: true },
    course: { type: String, default: "", trim: true },
    batch: { type: String, default: "", trim: true },
    sourceType: { type: String, default: "", trim: true },
    sourceId: { type: String, default: "", trim: true },
    params: { type: [String], default: [] },
    status: { type: String, enum: WA_RECIPIENT_STATUSES, default: "Pending" },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppMessage", default: null },
    providerMessageId: { type: String, default: "" },
    error: { type: String, default: "" },
    skipReason: { type: String, default: "" },
    lockedUntil: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

whatsappCampaignRecipientSchema.index({ campaignId: 1, phone: 1 }, { unique: true });
whatsappCampaignRecipientSchema.index({ campaignId: 1, status: 1 });
whatsappCampaignRecipientSchema.index({ messageId: 1 }, { partialFilterExpression: { messageId: { $type: "objectId" } } });

export const WhatsAppCampaignRecipient = mongoose.model(
  "WhatsAppCampaignRecipient",
  whatsappCampaignRecipientSchema,
  "whatsapp_campaign_recipients"
);
