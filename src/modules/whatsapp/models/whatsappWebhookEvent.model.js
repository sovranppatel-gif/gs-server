import mongoose from "mongoose";
import { WA_CONFIG } from "../whatsapp.config.js";

/**
 * One row per provider event (an inbound message or a single status change).
 * The unique eventId makes Meta's retried / duplicated deliveries no-ops.
 */
const whatsappWebhookEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    eventType: { type: String, enum: ["message", "status", "error", "unknown"], default: "unknown" },
    providerMessageId: { type: String, default: "" },
    phone: { type: String, default: "" },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    simulated: { type: Boolean, default: false },
    // Null means legacy/internal ingestion with no stored signature evidence.
    signatureVerified: { type: Boolean, default: null },
    signatureVerifiedAt: { type: Date, default: null },
    processingOutcome: { type: String, default: '' },
    status: { type: String, enum: ["received", "processing", "processed", "ignored", "failed"], default: "received" },
    error: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    receivedAt: { type: Date, default: Date.now },
    lockedUntil: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },
    processingToken: { type: String, default: "" },
    processedAt: { type: Date, default: null },
  },
  { versionKey: false }
);

whatsappWebhookEventSchema.index({ eventId: 1 }, { unique: true });
whatsappWebhookEventSchema.index({ status: 1, nextAttemptAt: 1, receivedAt: 1 });
whatsappWebhookEventSchema.index({ phone: 1, receivedAt: 1, status: 1 });
whatsappWebhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: WA_CONFIG.webhookEventTtlDays * 24 * 60 * 60 });

export const WhatsAppWebhookEvent = mongoose.model(
  "WhatsAppWebhookEvent",
  whatsappWebhookEventSchema,
  "whatsapp_webhook_events"
);
