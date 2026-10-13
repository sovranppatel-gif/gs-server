import { env } from "../../../config/env.js";
import { currentExecution } from "./execution.service.js";
import { templateSendability } from "./template.service.js";
import { Course } from "../../courses/courses.model.js";
import { Staff } from "../../staff/staff.model.js";
import {
  WhatsAppAutomation,
  WA_ACTION_TYPES,
  WA_STEP_TYPES,
  WA_TRIGGER_TYPES,
} from "../models/whatsappAutomation.model.js";
import { WhatsAppConversation, WA_CONVERSATION_STATUSES } from "../models/whatsappConversation.model.js";
import { WhatsAppTemplate } from "../models/whatsappTemplate.model.js";
import { WhatsAppSettings } from "../models/whatsappSettings.model.js";
import { getSettings, isWithinBusinessHours } from "./settings.service.js";
import { addContactTag, setOptOut } from "./contact.service.js";
import { findLeadForPhone, upsertLeadFromWhatsapp } from "./lead.service.js";
import { createOutbound } from "./message.service.js";
import { FLOW_RESET } from "./conversation.service.js";
import { DEFAULT_AUTOMATIONS } from "./automation.defaults.js";
import { assertObjectId, badRequest, cleanString, notFound, notifyAdmin } from "../whatsapp.utils.js";

const MENU_WORDS = new Set(["start", "menu", "main menu", "start over", "home"]);
const HANDOVER_WORDS = new Set(["agent", "human", "talk to team", "talk to our team", "call me", "representative"]);
const SKIP_WORDS = new Set(["skip", "-", "no", "na", "n/a", "nahi"]);
const KEY_EMOJI = { 1: "1️⃣", 2: "2️⃣", 3: "3️⃣", 4: "4️⃣", 5: "5️⃣", 6: "6️⃣", 7: "7️⃣", 8: "8️⃣", 9: "9️⃣", 10: "🔟" };
const MAX_MENU_RETRIES = 2;
const MAX_CHAINED_STEPS = 10;

export function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[️⃣]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const stripPunct = (s) => s.replace(/[!?.,;:'"()]+/g, " ").replace(/\s+/g, " ").trim();
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function triggerMatches(automation, text, isNew) {
  const type = automation.trigger?.type;
  const keywords = (automation.trigger?.keywords || []).map(normalizeText).filter(Boolean);
  const plain = stripPunct(text);
  switch (type) {
    case "incoming_message":
      return true;
    case "new_conversation":
      return Boolean(isNew);
    case "exact_match":
      return keywords.some((k) => stripPunct(k) === plain);
    case "contains":
      return keywords.some((k) => text.includes(k));
    case "keyword":
      return keywords.some((k) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRx(k)}($|[^\\p{L}\\p{N}])`, "u").test(text));
    default:
      return false;
  }
}

async function conditionsMatch(automation, ctx) {
  const c = automation.conditions || {};
  if (c.conversationStatuses?.length && !c.conversationStatuses.includes(ctx.conversation.status)) return false;
  if (c.contactTags?.length && !c.contactTags.some((t) => (ctx.contact.tags || []).includes(t))) return false;
  if (c.businessHours === "inside" && !isWithinBusinessHours(ctx.settings)) return false;
  if (c.businessHours === "outside" && isWithinBusinessHours(ctx.settings)) return false;
  if (c.leadStatuses?.length) {
    if (ctx.lead === undefined) ctx.lead = await findLeadForPhone(ctx.contact.normalizedPhone);
    if (!ctx.lead || !c.leadStatuses.includes(ctx.lead.status)) return false;
  }
  return true;
}

/** {{name}}, {{phone}} and any collected flow field, e.g. {{service}}. */
function renderText(text, ctx) {
  const data = ctx.conversation.flowData || {};
  const fallbackName = ctx.contact.displayName || ctx.contact.profileName || "";
  return String(text || "")
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
      if (key === "name") return data.name || fallbackName || "there";
      if (key === "phone") return ctx.contact.normalizedPhone;
      const v = data[key.replace(/^flow\./, "")];
      return v === undefined || v === null ? "" : String(v);
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function flowSummary(data = {}) {
  return Object.entries(data)
    .filter(([k, v]) => !k.startsWith("__") && v !== "" && v !== undefined && v !== null)
    .map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}: ${v}`)
    .join("; ");
}

async function reply(ctx, { text = "", template = null, automationId = null, origin = "automation" }) {
  const body = template ? "" : renderText(text, ctx);
  if (!template && !body) return null;
  const message = await createOutbound({
    conversationId: ctx.conversation._id,
    contactId: ctx.contact._id,
    phone: ctx.contact.normalizedPhone,
    text: body,
    template,
    origin,
    automationId,
    idempotencyKey: currentExecution() ? `${currentExecution().eventId}:reply:${currentExecution().outbound++}` : '',
  });
  ctx.replies.push(String(message._id));
  // Durable outbox only: the worker sends after the event transaction commits.
  return message;
}

async function saveConversation(ctx, $set) {
  Object.assign(ctx.conversation, $set);
  await WhatsAppConversation.updateOne({ _id: ctx.conversation._id }, { $set });
}

async function doHandover(ctx, reason) {
  await saveConversation(ctx, { humanHandover: true, handoverAt: new Date(), handoverReason: cleanString(reason, 200) || "Customer requested", status: "Pending", ...FLOW_RESET, flowData: {} });
  await reply(ctx, { text: ctx.settings.handoverMessage, origin: "system" });
  notifyAdmin("handover", { conversationId: String(ctx.conversation._id), on: true });
}

async function runAction(ctx, action, automation) {
  switch (action.type) {
    case "send_text":
    case "send_menu":
      await reply(ctx, { text: action.text, automationId: automation._id });
      break;
    case "send_template": {
      const t = action.templateId ? await WhatsAppTemplate.findById(action.templateId).lean() : null;
      if (t && templateSendability(t).allowed) await reply(ctx, { template: { name: t.name, language: t.language, params: [], bodyText: t.bodyText }, automationId: automation._id });
      break;
    }
    case "add_tag":
      if (action.tag) {
        await addContactTag(ctx.contact._id, action.tag);
        ctx.contact.tags = [...new Set([...(ctx.contact.tags || []), action.tag.toLowerCase()])];
      }
      break;
    case "create_lead":
    case "update_lead": {
      const data = ctx.conversation.flowData || {};
      const { lead } = await upsertLeadFromWhatsapp({
        phone: ctx.contact.normalizedPhone,
        name: data.name || ctx.contact.displayName || ctx.contact.profileName,
        interest: renderText(action.interest, ctx),
        notes: flowSummary(data) || `Automation: ${automation.name}`,
        status: action.type === "update_lead" ? action.status : "",
        conversationId: ctx.conversation._id,
      });
      ctx.lead = lead;
      break;
    }
    case "assign_staff":
      if (action.staffId) {
        const staff = await Staff.findById(action.staffId).select("personalDetails.fullName").lean();
        if (staff) await saveConversation(ctx, { assignedTo: staff._id, assignedToName: staff.personalDetails?.fullName || action.staffName || "Staff" });
      }
      break;
    case "change_status":
      if (WA_CONVERSATION_STATUSES.includes(action.status)) await saveConversation(ctx, { status: action.status });
      break;
    case "human_handover":
      await doHandover(ctx, action.reason || automation.name);
      return "stop";
    default:
      break;
  }
  return null;
}

async function runActions(ctx, actions = [], automation) {
  for (const action of actions) {
    if ((await runAction(ctx, action, automation)) === "stop") return "stop";
  }
  return null;
}

async function courseOptions() {
  const rows = await Course.find({ softDelete: { $ne: true }, status: "Active", $or: [{ category: "Training" }, { type: "Institute" }] })
    .select("name")
    .sort({ name: 1 })
    .limit(9)
    .maxTimeMS(5000)
    .lean();
  return rows.map((c, i) => ({ key: String(i + 1), label: c.name, keywords: [], value: c.name, nextStep: "", automationKey: "", action: "" }));
}

async function menuOptions(ctx, step) {
  if (step.dynamicOptions === "courses") {
    const live = await courseOptions().catch(() => []);
    if (live.length) {
      const extra = { key: String(live.length + 1), label: "Other / Talk to our team", keywords: ["other"], value: "Other", nextStep: "", automationKey: "", action: "" };
      // Same follow-up as the static list so the flow continues normally
      const follow = step.options?.[0]?.nextStep || "";
      return [...live.map((o) => ({ ...o, nextStep: follow })), { ...extra, nextStep: follow }];
    }
  }
  return step.options || [];
}

function menuText(header, options) {
  const list = options.map((o) => `${KEY_EMOJI[o.key] || `${o.key}.`} ${o.label}`).join("\n");
  return `${header}\n\n${list}`.trim();
}

/** Sends a step's prompt; message-type steps chain straight to the next step. */
async function enterStep(ctx, automation, stepId, depth = 0) {
  const step = automation.steps.find((s) => s.id === stepId);
  if (!step || depth > MAX_CHAINED_STEPS) return completeFlow(ctx, automation);

  if (step.type === "message") {
    await reply(ctx, { text: step.text, automationId: automation._id });
    return step.nextStep ? enterStep(ctx, automation, step.nextStep, depth + 1) : completeFlow(ctx, automation);
  }

  const patch = { currentAutomation: automation._id, currentStep: step.id, flowRetries: 0 };
  if (step.type === "menu") {
    const options = await menuOptions(ctx, step);
    // Snapshot so the reply maps to exactly the list the customer saw
    patch.flowData = { ...(ctx.conversation.flowData || {}), __options: options };
    await saveConversation(ctx, patch);
    await reply(ctx, { text: `${menuText(renderText(step.text, ctx), options)}${step.footerText ? `\n\n${renderText(step.footerText, ctx)}` : ""}`, automationId: automation._id });
  } else {
    await saveConversation(ctx, patch);
    await reply(ctx, { text: step.text, automationId: automation._id });
  }
  return null;
}

async function completeFlow(ctx, automation) {
  const stopped = await runActions(ctx, automation.completionActions, automation);
  if (stopped !== "stop" && automation.completionText) await reply(ctx, { text: automation.completionText, automationId: automation._id });
  await WhatsAppAutomation.updateOne({ _id: automation._id }, { $inc: { "stats.completions": 1 } });
  if (stopped !== "stop") await saveConversation(ctx, { ...FLOW_RESET, flowData: {} });
  return null;
}

async function findAutomationByKey(key) {
  if (!key) return null;
  const query = /^[a-f0-9]{24}$/i.test(key) ? { _id: key } : { systemKey: key };
  return WhatsAppAutomation.findOne({ ...query, enabled: true }).lean();
}

/** Runs an automation from the top: actions, then its flow (if any). */
async function runAutomation(ctx, automation, { carryData = {} } = {}) {
  await WhatsAppAutomation.updateOne({ _id: automation._id }, { $inc: { "stats.runs": 1 }, $set: { "stats.lastRunAt": new Date() } });
  ctx.matched = automation.name;
  await saveConversation(ctx, { ...FLOW_RESET, flowData: { ...carryData }, flowStartedAt: new Date() });
  if (automation.isFallback) await saveConversation(ctx, { lastFallbackAt: new Date() });
  if ((await runActions(ctx, automation.actions, automation)) === "stop") return;
  if (automation.steps?.length) {
    await enterStep(ctx, automation, automation.steps[0].id);
  } else if (automation.completionText) {
    await reply(ctx, { text: automation.completionText, automationId: automation._id });
  }
}

function matchOption(options, text, replyId) {
  if (replyId) {
    const byId = options.find((o) => o.key === replyId);
    if (byId) return byId;
  }
  const digits = text.match(/^\s*(\d{1,2})(?:\D|$)/);
  if (digits) {
    const byKey = options.find((o) => o.key === digits[1]);
    if (byKey) return byKey;
  }
  const plain = stripPunct(text);
  return (
    options.find((o) => normalizeText(o.label) === plain) ||
    options.find((o) => (o.keywords || []).some((k) => k && text.includes(normalizeText(k)))) ||
    null
  );
}

/** Returns true when the inbound message was consumed by the active flow. */
async function continueFlow(ctx, text, message) {
  const automation = await WhatsAppAutomation.findOne({ _id: ctx.conversation.currentAutomation, enabled: true }).lean();
  const step = automation?.steps?.find((s) => s.id === ctx.conversation.currentStep);
  if (!automation || !step) {
    await saveConversation(ctx, { ...FLOW_RESET, flowData: {} });
    return false;
  }
  const data = { ...(ctx.conversation.flowData || {}) };

  if (step.type === "question") {
    const raw = cleanString(message.text, 500);
    if (!raw) {
      await reply(ctx, { text: `Please reply with text 🙂\n\n${step.text}`, automationId: automation._id });
      return true;
    }
    data[step.field || step.id] = step.optional && SKIP_WORDS.has(text) ? "" : raw;
    await saveConversation(ctx, { flowData: data });
    if (step.nextStep) await enterStep(ctx, automation, step.nextStep);
    else await completeFlow(ctx, automation);
    return true;
  }

  // menu
  const options = Array.isArray(data.__options) && data.__options.length ? data.__options : step.options;
  const option = matchOption(options, text, message.interactive?.replyId);
  if (!option) {
    const retries = (ctx.conversation.flowRetries || 0) + 1;
    if (retries > MAX_MENU_RETRIES) {
      await saveConversation(ctx, { ...FLOW_RESET, flowData: {} });
      ctx.forceFallback = true;
      return false;
    }
    await saveConversation(ctx, { flowRetries: retries });
    await reply(ctx, { text: `Please reply with a number from the list 🙏\n\n${`${menuText(renderText(step.text, ctx), options)}${step.footerText ? `\n\n${renderText(step.footerText, ctx)}` : ""}`}`, automationId: automation._id });
    return true;
  }

  data[step.field || step.id] = option.value || option.label;
  delete data.__options;
  await saveConversation(ctx, { flowData: data, flowRetries: 0 });

  if (option.action === "handover") {
    await doHandover(ctx, `Menu: ${option.label}`);
    return true;
  }
  if (option.action === "end") {
    await completeFlow(ctx, automation);
    return true;
  }
  if (option.automationKey) {
    const target = await findAutomationByKey(option.automationKey);
    if (target) {
      await runAutomation(ctx, target, { carryData: data });
      return true;
    }
  }
  const next = option.nextStep || step.nextStep;
  if (next) await enterStep(ctx, automation, next);
  else await completeFlow(ctx, automation);
  return true;
}

function keywordHit(text, list = []) {
  const plain = stripPunct(text);
  return list.some((k) => stripPunct(normalizeText(k)) === plain);
}

/**
 * Entry point for every stored inbound message. Outbound messages are
 * rejected up front, so the bot can never answer itself.
 */
export async function handleInbound({ conversation, contact, message, isNew }) {
  if (!message || message.direction !== "inbound") return { skipped: "not_inbound" };

  await ensureDefaultAutomations();
  const settings = await getSettings();
  const conv = conversation.toObject ? conversation.toObject() : { ...conversation };
  const ctx = { conversation: conv, contact: contact.toObject ? contact.toObject() : { ...contact }, settings, replies: [], lead: undefined, matched: "" };
  const text = normalizeText(message.text);

  // 1. Consent keywords always win
  if (text && keywordHit(text, settings.optOutKeywords)) {
    await setOptOut(contact._id, true);
    await saveConversation(ctx, { ...FLOW_RESET, flowData: {} });
    if (!conv.humanHandover) await reply(ctx, { text: settings.optOutConfirmation, origin: "system" });
    return { action: "opted_out", replies: ctx.replies };
  }
  if (text && keywordHit(text, settings.optInKeywords)) {
    await setOptOut(contact._id, false);
    ctx.contact.optOut = false;
    if (!conv.humanHandover && !['start'].includes(stripPunct(text))) await reply(ctx, { text: settings.optInConfirmation, origin: "system" });
    if (stripPunct(text) !== 'start') return { action: "opted_in", replies: ctx.replies };
  }
  if (ctx.contact.optOut) return { skipped: "opted_out" };

  // 2. Human handover pauses automation entirely
  if (conv.humanHandover) {
    notifyAdmin("handover_message", { conversationId: String(conv._id) });
    return { skipped: "human_handover" };
  }
  if (!env.whatsappAutoReplyEnabled || !settings.autoReplyEnabled) return { skipped: "auto_reply_disabled" };

  // 3. Global escape words
  if (text && HANDOVER_WORDS.has(stripPunct(text))) {
    await doHandover(ctx, "Customer asked for a person");
    return { action: "handover", replies: ctx.replies };
  }
  const wantsMenu = text && MENU_WORDS.has(stripPunct(text));

  // 4. Active flow consumes the reply
  if (!wantsMenu && conv.currentAutomation && conv.currentStep) {
    if (await continueFlow(ctx, text, message)) return { action: "flow", replies: ctx.replies };
  }

  // 5. First matching automation (by priority)
  const automations = await WhatsAppAutomation.find({ enabled: true }).sort({ priority: 1, createdAt: 1 }).lean();
  if (!wantsMenu) {
    for (const automation of automations.filter((a) => !a.isFallback)) {
      if (triggerMatches(automation, text, isNew) && (await conditionsMatch(automation, ctx))) {
        await runAutomation(ctx, automation);
        return { action: "automation", automation: automation.name, replies: ctx.replies };
      }
    }
  }

  // 6. Fallback menu (rate-limited so random chatter isn't answered with a menu every time)
  if (!settings.fallbackEnabled && !wantsMenu) return { skipped: "no_match" };
  const cooldownMs = (settings.fallbackCooldownMinutes || 0) * 60 * 1000;
  const recentFallback = conv.lastFallbackAt && Date.now() - new Date(conv.lastFallbackAt).getTime() < cooldownMs;
  if (recentFallback && !wantsMenu && !ctx.forceFallback && !isNew) return { skipped: "fallback_cooldown" };
  for (const automation of automations.filter((a) => a.isFallback)) {
    if (await conditionsMatch(automation, ctx)) {
      await runAutomation(ctx, automation);
      return { action: "fallback", automation: automation.name, replies: ctx.replies };
    }
  }
  return { skipped: "no_match" };
}

// ---------------------------------------------------------------- admin CRUD

export async function seedDefaultAutomations() {
  let created = 0;
  for (const def of DEFAULT_AUTOMATIONS) {
    const res = await WhatsAppAutomation.updateOne({ systemKey: def.systemKey }, { $setOnInsert: def }, { upsert: true });
    created += res.upsertedCount || 0;
  }
  return { created };
}

let defaultsReady = null;

/** Seeds the defaults the first time the module is used (tracked in settings). */
export function ensureDefaultAutomations() {
  if (!defaultsReady) {
    defaultsReady = (async () => {
      const settings = await getSettings();
      if (settings.defaultsSeededAt) return;
      await seedDefaultAutomations();
      await WhatsAppSettings.updateOne({ key: "default", defaultsSeededAt: null }, { $set: { defaultsSeededAt: new Date() } });
    })().catch((err) => {
      defaultsReady = null;
      throw err;
    });
  }
  return defaultsReady;
}

function normalizeAction(a = {}) {
  if (!WA_ACTION_TYPES.includes(a.type)) throw badRequest(`Unknown action type: ${a.type}`);
  return {
    type: a.type,
    text: cleanString(a.text, 4096),
    templateId: a.templateId ? assertObjectId(a.templateId, "template id") : null,
    tag: cleanString(a.tag, 40).toLowerCase(),
    status: cleanString(a.status, 40),
    staffId: a.staffId ? assertObjectId(a.staffId, "staff id") : null,
    staffName: cleanString(a.staffName, 120),
    interest: cleanString(a.interest, 150),
    reason: cleanString(a.reason, 200),
  };
}

function normalizeSteps(steps = []) {
  if (!Array.isArray(steps)) throw badRequest("steps must be a list");
  const ids = new Set();
  const out = steps.slice(0, 30).map((s, i) => {
    const id = cleanString(s.id, 40) || `step${i + 1}`;
    if (ids.has(id)) throw badRequest(`Duplicate step id: ${id}`);
    ids.add(id);
    if (!WA_STEP_TYPES.includes(s.type)) throw badRequest(`Invalid step type for ${id}`);
    const options = (Array.isArray(s.options) ? s.options : []).slice(0, 10).map((o, j) => ({
      key: cleanString(o.key, 3) || String(j + 1),
      label: cleanString(o.label, 80) || `Option ${j + 1}`,
      keywords: (Array.isArray(o.keywords) ? o.keywords : String(o.keywords || "").split(",")).map((k) => cleanString(k, 40)).filter(Boolean),
      value: cleanString(o.value, 120),
      nextStep: cleanString(o.nextStep, 40),
      automationKey: cleanString(o.automationKey, 60),
      action: ["handover", "end"].includes(o.action) ? o.action : "",
    }));
    if (s.type === "menu" && !options.length && s.dynamicOptions !== "courses") throw badRequest(`Menu step ${id} needs options`);
    return {
      id,
      type: s.type,
      text: cleanString(s.text, 4096),
      field: cleanString(s.field, 40).replace(/[^\w]/g, ""),
      optional: Boolean(s.optional),
      footerText: cleanString(s.footerText, 1000),
      options,
      dynamicOptions: s.dynamicOptions === "courses" ? "courses" : "",
      nextStep: cleanString(s.nextStep, 40),
    };
  });
  for (const s of out) {
    for (const ref of [s.nextStep, ...s.options.map((o) => o.nextStep)]) {
      if (ref && !ids.has(ref)) throw badRequest(`Step ${s.id} points to unknown step "${ref}"`);
    }
  }
  return out;
}

function normalizeAutomation(body = {}) {
  const name = cleanString(body.name, 120);
  if (!name) throw badRequest("Name is required");
  const triggerType = body.trigger?.type || "contains";
  if (!WA_TRIGGER_TYPES.includes(triggerType)) throw badRequest("Invalid trigger type");
  const keywords = (Array.isArray(body.trigger?.keywords) ? body.trigger.keywords : String(body.trigger?.keywords || "").split(","))
    .map((k) => cleanString(k, 60))
    .filter(Boolean)
    .slice(0, 50);
  if (["keyword", "exact_match", "contains"].includes(triggerType) && !keywords.length && !body.isFallback) {
    throw badRequest("Add at least one keyword for this trigger");
  }
  const c = body.conditions || {};
  const list = (v) => (Array.isArray(v) ? v : String(v || "").split(",")).map((x) => cleanString(x, 40)).filter(Boolean);
  return {
    name,
    description: cleanString(body.description, 500),
    enabled: body.enabled !== false,
    isFallback: Boolean(body.isFallback),
    priority: Math.max(0, Math.min(10000, Number(body.priority) || 100)),
    trigger: { type: triggerType, keywords },
    conditions: {
      conversationStatuses: list(c.conversationStatuses).filter((s) => WA_CONVERSATION_STATUSES.includes(s)),
      leadStatuses: list(c.leadStatuses),
      contactTags: list(c.contactTags).map((t) => t.toLowerCase()),
      businessHours: ["inside", "outside"].includes(c.businessHours) ? c.businessHours : "any",
    },
    actions: (Array.isArray(body.actions) ? body.actions : []).slice(0, 20).map(normalizeAction),
    steps: normalizeSteps(body.steps || []),
    completionText: cleanString(body.completionText, 4096),
    completionActions: (Array.isArray(body.completionActions) ? body.completionActions : []).slice(0, 20).map(normalizeAction),
  };
}

export async function listAutomations() {
  await ensureDefaultAutomations();
  return WhatsAppAutomation.find().sort({ isFallback: 1, priority: 1, createdAt: 1 }).lean();
}

export async function getAutomation(id) {
  const a = await WhatsAppAutomation.findById(assertObjectId(id, "automation id")).lean();
  if (!a) throw notFound("Automation not found");
  return a;
}

export async function createAutomation(body, by) {
  const doc = await WhatsAppAutomation.create({ ...normalizeAutomation(body), createdBy: by, updatedBy: by });
  return doc.toObject();
}

export async function updateAutomation(id, body, by) {
  const existing = await WhatsAppAutomation.findById(assertObjectId(id, "automation id"));
  if (!existing) throw notFound("Automation not found");
  const data = body && Object.keys(body).length === 1 && "enabled" in body ? { enabled: Boolean(body.enabled) } : normalizeAutomation({ ...existing.toObject(), ...body });
  Object.assign(existing, data, { updatedBy: by });
  await existing.save();
  return existing.toObject();
}

export async function deleteAutomation(id) {
  const a = await WhatsAppAutomation.findById(assertObjectId(id, "automation id"));
  if (!a) throw notFound("Automation not found");
  await WhatsAppConversation.updateMany({ currentAutomation: a._id }, { $set: { ...FLOW_RESET, flowData: {} } });
  await a.deleteOne();
  return { deleted: true };
}

/** "Which automation would answer this text?" — no messages are sent. */
export async function testAutomationMatch(text, { isNew = false } = {}) {
  const t = normalizeText(text);
  const settings = await getSettings();
  if (keywordHit(t, settings.optOutKeywords)) return { result: "opt_out_keyword" };
  if (keywordHit(t, settings.optInKeywords)) return { result: "opt_in_keyword" };
  if (HANDOVER_WORDS.has(stripPunct(t))) return { result: "human_handover" };
  const automations = await WhatsAppAutomation.find({ enabled: true }).sort({ priority: 1, createdAt: 1 }).lean();
  const hit = automations.find((a) => !a.isFallback && triggerMatches(a, t, isNew));
  if (hit) return { result: "automation", automation: { _id: hit._id, name: hit.name }, note: "Conditions (status, tags, lead, hours) are checked at run time." };
  const fb = automations.find((a) => a.isFallback);
  return fb ? { result: "fallback", automation: { _id: fb._id, name: fb.name } } : { result: "no_match" };
}
