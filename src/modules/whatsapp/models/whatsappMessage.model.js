import mongoose from "mongoose";

/**
 * queued    → waiting in the durable outbox (worker / immediate dispatch)
 * accepted  → Meta returned a message id (or dry-run simulated it)
 * sent / delivered / read → only from the status webhook (or dry-run simulation)
 * failed    → API or webhook reported an error
 */
export const WA_MESSAGE_STATUSES = Object.freeze(["queued", "accepted", "sent", "delivered", "read", "failed", "received"]);
export const WA_MESSAGE_ORIGINS = Object.freeze(["customer", "agent", "automation", "campaign", "system"]);
export const WA_STATUS_RANK = Object.freeze({ queued: 0, accepted: 1, sent: 2, delivered: 3, read: 4 });

const errorSchema = new mongoose.Schema(
  {
    code: { type: String, default: "" },
    message: { type: String, default: "" },
    retryable: { type: Boolean, default: false },
  },
  { _id: false }
);

const whatsappMessageSchema = new mongoose.Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppConversation", default: null },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppContact", default: null },
    phone: { type: String, required: true, trim: true },
    providerMessageId: { type: String, default: "" },
    direction: { type: String, enum: ["inbound", "outbound"], required: true },
    messageType: { type: String, default: "text" },
    text: { type: String, default: "" },
    templateName: { type: String, default: "" },
    templateLanguage: { type: String, default: "" },
    templateParams: { type: [String], default: [] },
    interactive: { type: mongoose.Schema.Types.Mixed, default: null },
    media: { type: mongoose.Schema.Types.Mixed, default: null },
    status: { type: String, enum: WA_MESSAGE_STATUSES, default: "queued" },
    error: { type: errorSchema, default: null },
    origin: { type: String, enum: WA_MESSAGE_ORIGINS, default: "customer" },
    automationId: { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppAutomation", default: null },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppCampaign", default: null },
    campaignRecipientId: { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppCampaignRecipient", default: null },
    sentBy: { type: String, default: "", trim: true },
    dryRun: { type: Boolean, default: false },

    // Outbox bookkeeping
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },

    acceptedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false }
);

// Idempotency: one row per provider message id
whatsappMessageSchema.index(
  { providerMessageId: 1 },
  { unique: true, partialFilterExpression: { providerMessageId: { $type: "string", $gt: "" } } }
);
whatsappMessageSchema.index({ conversationId: 1, timestamp: -1 });
whatsappMessageSchema.index({ status: 1, nextAttemptAt: 1 }, { partialFilterExpression: { status: "queued" } });
whatsappMessageSchema.index({ campaignId: 1, status: 1 });
whatsappMessageSchema.index({ createdAt: -1 });
whatsappMessageSchema.index({ direction: 1, createdAt: -1 });
whatsappMessageSchema.index({ origin: 1, createdAt: -1 });
whatsappMessageSchema.index({ phone: 1, createdAt: -1 });
whatsappMessageSchema.index({ acceptedAt: -1 });

export const WhatsAppMessage = mongoose.model("WhatsAppMessage", whatsappMessageSchema, "whatsapp_messages");
