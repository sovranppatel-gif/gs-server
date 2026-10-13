import { safeError } from "./whatsapp.security.js";
import crypto from "crypto";
import { env } from "../../config/env.js";
import { verifySignature } from "./whatsapp.client.js";
import * as wa from "./whatsapp.service.js";
import * as contacts from "./services/contact.service.js";
import * as conversations from "./services/conversation.service.js";
import * as messages from "./services/message.service.js";
import * as automations from "./services/automation.service.js";
import * as templates from "./services/template.service.js";
import * as campaigns from "./services/campaign.service.js";
import * as audience from "./services/audience.service.js";
import * as settings from "./services/settings.service.js";
import * as reports from "./services/reports.service.js";
import { ingestWebhook, listWebhookEvents, retryWebhookEvent } from "./services/webhook.service.js";
import { runWorkerTick } from "./services/worker.service.js";
import { validateSimulatedInbound, validateSimulatedStatus, validateStartConversation } from "./whatsapp.validation.js";
import { editor, handle } from "./whatsapp.utils.js";

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Webhook (public — Meta) ---------------------------------------------------------

/** GET: Meta verification handshake. */
export function webhookVerify(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && env.whatsappVerifyToken && safeEqual(token, env.whatsappVerifyToken)) {
    return res.status(200).type("text/plain").send(String(challenge ?? ""));
  }
  return res.sendStatus(403);
}

/** POST: signature check → persist → process. Raw body is mounted by index.js. */
export async function webhookReceive(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  const check = verifySignature(raw, req.headers["x-hub-signature-256"]);
  if (!check.valid) {
    if (check.reason === "app_secret_missing") {
      console.error("[whatsapp] webhook rejected: WHATSAPP_APP_SECRET is required");
      return res.sendStatus(503);
    }
    return res.sendStatus(401);
  }

  let body;
  try {
    body = JSON.parse(raw ? raw.toString("utf8") : "{}");
  } catch {
    return res.sendStatus(400);
  }
  try {
    await ingestWebhook(body);
    return res.sendStatus(200);
  } catch (err) {
    // Persisting failed (e.g. DB down) → non-200 so Meta redelivers later
    console.error("[whatsapp] webhook persistence failed:", safeError(err));
    return res.sendStatus(500);
  }
}

// Serverless queue tick (Vercel Cron: Authorization: Bearer $CRON_SECRET) ----------
export async function cronTick(req, res) {
  if (!env.cronSecret) return res.status(404).json({ success: false, message: "Not found" });
  const [type, token] = String(req.headers.authorization || "").split(" ");
  if (type !== "Bearer" || !safeEqual(token, env.cronSecret)) return res.status(401).json({ success: false, message: "Unauthorized" });
  try {
    const result = await runWorkerTick({ maxCampaignSends: 40, deadline: Date.now() + 40000 });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[whatsapp] cron tick failed:", safeError(err));
    return res.status(500).json({ success: false, message: "Tick failed" });
  }
}

// Overview / settings -----------------------------------------------------------------
export const getStatus = handle((req) => wa.getOverviewStatus(req.masterAdmin), { tag: "status" });
export const getSettings = handle((req) => wa.getSettingsView(req.masterAdmin), { tag: "get settings" });
export const updateSettings = handle((req) => settings.updateSettings(req.body, editor(req)), { tag: "update settings" });
export const testConnection = handle(() => wa.testConnection(), { tag: "test connection" });
export const webhookEvents = handle((req) => listWebhookEvents(req.query), { tag: "webhook events" });
export const retryEvent = handle((req) => retryWebhookEvent(req.params.id), { tag: 'retry webhook event' });
export const runWorker = handle(() => runWorkerTick({ maxCampaignSends: 40 }), { tag: "run worker" });

// Conversations -------------------------------------------------------------------
export const listConversations = handle((req) => conversations.listConversations(req.query), { tag: "list conversations" });
export const getConversation = handle((req) => conversations.getConversation(req.params.id), { tag: "get conversation" });
export const getConversationMessages = handle((req) => conversations.getConversationMessages(req.params.id, req.query), { tag: "conversation messages" });
export const markConversationRead = handle((req) => conversations.markRead(req.params.id), { tag: "mark read" });
export const updateConversation = handle((req) => conversations.updateConversation(req.params.id, req.body), { tag: "update conversation" });
export const handoverConversation = handle((req) => conversations.setHandover(req.params.id, true, req.body?.reason), { tag: "handover" });
export const resumeAutomation = handle((req) => conversations.setHandover(req.params.id, false), { tag: "resume automation" });
export const replyToConversation = handle((req) => messages.sendAgentReply(req.params.id, req.body, editor(req)), { status: 201, tag: "reply", errorMessage: "Failed to send message" });
export const startConversation = handle((req) => wa.startConversation(validateStartConversation(req.body), editor(req)), { status: 201, tag: "start conversation" });

// Contacts ----------------------------------------------------------------------
export const listContacts = handle((req) => contacts.listContacts(req.query), { tag: "list contacts" });
export const getContact = handle((req) => contacts.getContact(req.params.id), { tag: "get contact" });
export const createContact = handle((req) => contacts.createContact(req.body, editor(req)), { status: 201, tag: "create contact" });
export const updateContact = handle((req) => contacts.updateContact(req.params.id, req.body, editor(req)), { tag: "update contact" });
export const resolveContact = handle((req) => contacts.reresolveContact(req.params.id), { tag: "resolve contact" });
export const optOutContact = handle((req) => contacts.updateContact(req.params.id, { consentStatus: "opted_out" }, editor(req)), { tag: "opt out" });
export const optInContact = handle((req) => contacts.updateContact(req.params.id, { consentStatus: "opted_in" }, editor(req)), { tag: "opt in" });
export const listTags = handle(() => contacts.listTags(), { tag: "tags" });
export const staffOptions = handle(() => contacts.staffOptions(), { tag: "staff options" });

// Messages ----------------------------------------------------------------------
export const listMessages = handle((req) => messages.listMessages(req.query), { tag: "list messages" });
export const retryMessage = handle((req) => messages.retryMessage(req.params.id), { tag: "retry message" });

// Automations -------------------------------------------------------------------
export const listAutomations = handle(() => automations.listAutomations(), { tag: "list automations" });
export const getAutomation = handle((req) => automations.getAutomation(req.params.id), { tag: "get automation" });
export const createAutomation = handle((req) => automations.createAutomation(req.body, editor(req)), { status: 201, tag: "create automation" });
export const updateAutomation = handle((req) => automations.updateAutomation(req.params.id, req.body, editor(req)), { tag: "update automation" });
export const deleteAutomation = handle((req) => automations.deleteAutomation(req.params.id), { tag: "delete automation" });
export const testAutomation = handle((req) => automations.testAutomationMatch(req.body?.text, { isNew: Boolean(req.body?.isNew) }), { tag: "test automation" });

// Templates ---------------------------------------------------------------------
export const listTemplates = handle((req) => templates.listTemplates(req.query), { tag: "list templates" });
export const getTemplate = handle((req) => templates.getTemplate(req.params.id), { tag: "get template" });
export const createTemplate = handle((req) => templates.createTemplate(req.body, editor(req)), { status: 201, tag: "create template" });
export const updateTemplate = handle((req) => templates.updateTemplate(req.params.id, req.body, editor(req)), { tag: "update template" });
export const deleteTemplate = handle((req) => templates.deleteTemplate(req.params.id), { tag: "delete template" });
export const syncTemplates = handle(() => templates.syncTemplatesFromMeta(), { tag: "sync templates" });
export const submitTemplate = handle((req) => templates.submitTemplateToMeta(req.params.id, editor(req)), { tag: "submit template" });

// Audience & campaigns ------------------------------------------------------------
export const audienceOptions = handle(() => audience.audienceOptions(), { tag: "audience options" });
export const previewCampaign = handle((req) => campaigns.previewCampaign(req.body), { tag: "preview campaign" });
export const listCampaigns = handle((req) => campaigns.listCampaigns(req.query), { tag: "list campaigns" });
export const getCampaign = handle((req) => campaigns.getCampaign(req.params.id), { tag: "get campaign" });
export const createCampaign = handle((req) => campaigns.createCampaign(req.body, editor(req)), { status: 201, tag: "create campaign", errorMessage: "Failed to create campaign" });
export const listRecipients = handle((req) => campaigns.listRecipients(req.params.id, req.query), { tag: "list recipients" });
export const pauseCampaign = handle((req) => campaigns.pauseCampaign(req.params.id, editor(req)), { tag: "pause campaign" });
export const resumeCampaign = handle((req) => campaigns.resumeCampaign(req.params.id, editor(req)), { tag: "resume campaign" });
export const cancelCampaign = handle((req) => campaigns.cancelCampaign(req.params.id, editor(req)), { tag: "cancel campaign" });
export const retryFailedCampaign = handle((req) => campaigns.retryFailed(req.params.id, editor(req)), { tag: "retry campaign" });
export const deleteCampaign = handle((req) => campaigns.deleteCampaign(req.params.id), { tag: "delete campaign" });
export const exportCampaign = handle(
  async (req, res) => {
    const { filename, csv } = await campaigns.exportCampaignCsv(req.params.id);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  },
  { tag: "export campaign" }
);

// Reports -----------------------------------------------------------------------
export const getReport = handle((req) => reports.getReport(req.query), { tag: "report" });

// Dry-run simulation ----------------------------------------------------------------
export const simulateInbound = handle((req) => wa.simulateInbound(validateSimulatedInbound(req.body)), { tag: "simulate inbound" });
export const simulateStatus = handle((req) => wa.simulateStatus(validateSimulatedStatus(req.body)), { tag: "simulate status" });
