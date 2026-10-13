import mongoose from "mongoose";

export const WA_TRIGGER_TYPES = Object.freeze(["incoming_message", "keyword", "exact_match", "contains", "new_conversation"]);
export const WA_ACTION_TYPES = Object.freeze([
  "send_text",
  "send_template",
  "send_menu",
  "add_tag",
  "create_lead",
  "update_lead",
  "assign_staff",
  "change_status",
  "human_handover",
]);
export const WA_STEP_TYPES = Object.freeze(["message", "menu", "question"]);

/**
 * Trigger → conditions → actions, plus an optional multi-step flow
 * (menus / questions) whose answers are collected into conversation.flowData
 * and handed to the completion actions (e.g. create_lead).
 */
const actionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: WA_ACTION_TYPES, required: true },
    text: { type: String, default: "" }, // send_text / send_menu
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppTemplate", default: null },
    tag: { type: String, default: "" },
    status: { type: String, default: "" }, // change_status (conversation) / update_lead (lead status)
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
    staffName: { type: String, default: "" },
    interest: { type: String, default: "" }, // create_lead / update_lead
    reason: { type: String, default: "" }, // human_handover
  },
  { _id: false }
);

const optionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true }, // "1", "2"…
    label: { type: String, required: true, trim: true },
    keywords: { type: [String], default: [] },
    value: { type: String, default: "" }, // stored in flowData[step.field]; defaults to label
    nextStep: { type: String, default: "" }, // step id inside this automation
    automationKey: { type: String, default: "" }, // jump to another automation (systemKey or _id)
    action: { type: String, enum: ["", "handover", "end"], default: "" },
  },
  { _id: false }
);

const stepSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    type: { type: String, enum: WA_STEP_TYPES, required: true },
    text: { type: String, default: "" },
    footerText: { type: String, default: "" },
    field: { type: String, default: "", trim: true }, // flowData key for the answer
    optional: { type: Boolean, default: false }, // question can be skipped with "skip"
    options: { type: [optionSchema], default: [] },
    dynamicOptions: { type: String, enum: ["", "courses"], default: "" }, // menu filled from live data
    nextStep: { type: String, default: "" },
  },
  { _id: false }
);

const whatsappAutomationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    systemKey: { type: String, default: null, trim: true }, // seeded defaults
    enabled: { type: Boolean, default: true },
    isFallback: { type: Boolean, default: false }, // runs when nothing else matched
    priority: { type: Number, default: 100 }, // lower runs first
    trigger: {
      type: { type: String, enum: WA_TRIGGER_TYPES, default: "contains" },
      keywords: { type: [String], default: [] },
    },
    conditions: {
      conversationStatuses: { type: [String], default: [] },
      leadStatuses: { type: [String], default: [] },
      contactTags: { type: [String], default: [] },
      businessHours: { type: String, enum: ["any", "inside", "outside"], default: "any" },
    },
    actions: { type: [actionSchema], default: [] },
    steps: { type: [stepSchema], default: [] },
    completionText: { type: String, default: "" },
    completionActions: { type: [actionSchema], default: [] },
    stats: {
      runs: { type: Number, default: 0 },
      completions: { type: Number, default: 0 },
      lastRunAt: { type: Date, default: null },
    },
    createdBy: { type: String, default: "system", trim: true },
    updatedBy: { type: String, default: "system", trim: true },
  },
  { timestamps: true, versionKey: false }
);

whatsappAutomationSchema.index({ enabled: 1, priority: 1 });
whatsappAutomationSchema.index(
  { systemKey: 1 },
  { unique: true, partialFilterExpression: { systemKey: { $type: "string" } } }
);

export const WhatsAppAutomation = mongoose.model(
  "WhatsAppAutomation",
  whatsappAutomationSchema,
  "whatsapp_automations"
);
