import mongoose from "mongoose";
import { env } from "../../../config/env.js";

/** Singleton (key "default") holding admin-editable WhatsApp behaviour. */
const whatsappSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "default" },
    autoReplyEnabled: { type: Boolean, default: () => env.whatsappAutoReplyEnabled },
    fallbackEnabled: { type: Boolean, default: true },
    fallbackCooldownMinutes: { type: Number, default: 30, min: 0 },
    businessHours: {
      timezone: { type: String, default: () => env.whatsappBusinessTimezone },
      days: { type: [Number], default: [1, 2, 3, 4, 5, 6] }, // 0 = Sunday
      start: { type: String, default: "10:00" },
      end: { type: String, default: "19:00" },
    },
    handoverMessage: {
      type: String,
      default: "🙏 Thank you! Our team member will contact you shortly. Aapka message team ko bhej diya gaya hai.",
    },
    optOutKeywords: { type: [String], default: ["STOP", "UNSUBSCRIBE", "STOP ALL", "OPT OUT"] },
    optInKeywords: { type: [String], default: ["START", "SUBSCRIBE"] },
    optOutConfirmation: {
      type: String,
      default: "You have been unsubscribed from Grow Skills Tech WhatsApp messages. Reply START to subscribe again.",
    },
    optInConfirmation: { type: String, default: "✅ You are subscribed to Grow Skills Tech WhatsApp updates again." },
    campaignRatePerMinute: { type: Number, default: 60, min: 1, max: 1000 },
    // Default automations are inserted once; deleting one later keeps it deleted.
    defaultsSeededAt: { type: Date, default: null },
    workerLastTickAt: { type: Date, default: null },
    workerLeaseToken: { type: String, default: '' },
    workerLockedUntil: { type: Date, default: null },
    workerLastCompletedAt: { type: Date, default: null },
    workerLastError: { type: String, default: '' },
    connectionTest: {
      testedAt: { type: Date, default: null },
      ok: { type: Boolean, default: false },
      error: { type: String, default: '' },
      phoneNumberId: { type: String, default: '' },
    },
    updatedBy: { type: String, default: "system", trim: true },
  },
  { timestamps: true, versionKey: false }
);

whatsappSettingsSchema.index({ key: 1 }, { unique: true });

export const WhatsAppSettings = mongoose.model("WhatsAppSettings", whatsappSettingsSchema, "whatsapp_settings");
