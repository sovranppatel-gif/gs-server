import mongoose from "mongoose";

export const WA_CONVERSATION_STATUSES = Object.freeze(["New", "Open", "Pending", "Follow-up", "Converted", "Closed"]);

/** One conversation thread per contact; status cycles (Closed → Open on a new inbound). */
const whatsappConversationSchema = new mongoose.Schema(
  {
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppContact", required: true },
    phone: { type: String, required: true, trim: true },
    status: { type: String, enum: WA_CONVERSATION_STATUSES, default: "New" },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
    assignedToName: { type: String, default: "", trim: true },
    unreadCount: { type: Number, default: 0, min: 0 },
    lastMessage: { type: String, default: "", trim: true },
    lastMessageAt: { type: Date, default: null },
    lastMessageDirection: { type: String, enum: ["inbound", "outbound", ""], default: "" },
    lastInboundAt: { type: Date, default: null },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
    tags: { type: [String], default: [] },

    // Human handover — automation is paused while true
    humanHandover: { type: Boolean, default: false },
    handoverAt: { type: Date, default: null },
    handoverReason: { type: String, default: "", trim: true },

    // Automation flow state
    currentAutomation: { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppAutomation", default: null },
    currentStep: { type: String, default: "" },
    flowData: { type: mongoose.Schema.Types.Mixed, default: {} },
    flowRetries: { type: Number, default: 0 },
    flowStartedAt: { type: Date, default: null },
    lastFallbackAt: { type: Date, default: null },

    closedAt: { type: Date, default: null },
    reopenedCount: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, minimize: false }
);

whatsappConversationSchema.index({ contactId: 1 }, { unique: true });
whatsappConversationSchema.index({ phone: 1 });
whatsappConversationSchema.index({ status: 1, lastMessageAt: -1 });
whatsappConversationSchema.index({ assignedTo: 1, lastMessageAt: -1 });
whatsappConversationSchema.index({ lastMessageAt: -1 });
whatsappConversationSchema.index({ humanHandover: 1, lastMessageAt: -1 });
whatsappConversationSchema.index({ createdAt: -1 });

export const WhatsAppConversation = mongoose.model(
  "WhatsAppConversation",
  whatsappConversationSchema,
  "whatsapp_conversations"
);
