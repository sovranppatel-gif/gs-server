import { runWorkerTick, getWorkerState } from "./services/worker.service.js";
import { WhatsAppSettings } from "./models/whatsappSettings.model.js";
import { safeError } from "./whatsapp.security.js";
import crypto from "crypto";
import { env } from "../../config/env.js";
import { WhatsAppTemplate } from "./models/whatsappTemplate.model.js";
import { WhatsAppMessage } from "./models/whatsappMessage.model.js";
import { WhatsAppConversation } from "./models/whatsappConversation.model.js";
import { WhatsAppWebhookEvent } from "./models/whatsappWebhookEvent.model.js";
import { getConnectionStatus, isDryRun } from "./whatsapp.config.js";
import { checkPhoneNumber } from "./whatsapp.client.js";
import { findOrCreateContact } from "./services/contact.service.js";
import { getOrOpenConversation, getConversation } from "./services/conversation.service.js";
import { createOutbound, dispatchMessage } from "./services/message.service.js";
import { templateSendability } from "./services/template.service.js";
import { ingestWebhook } from "./services/webhook.service.js";
import { getSettings } from "./services/settings.service.js";
import { permissionsFor } from "./whatsapp.permissions.js";
import { assertObjectId, badRequest, HttpError, notFound } from "./whatsapp.utils.js";

/** Module-level operations that span several services. */

export async function getOverviewStatus(masterAdmin) {
  const [unread, handover, queued, failedEvents] = await Promise.all([
    WhatsAppConversation.countDocuments({ unreadCount: { $gt: 0 } }),
    WhatsAppConversation.countDocuments({ humanHandover: true }),
    WhatsAppMessage.countDocuments({ status: "queued" }),
    WhatsAppWebhookEvent.countDocuments({ status: "failed" }),
  ]);
  return { connection: getConnectionStatus(), counters: { unread, handover, queued, failedEvents }, permissions: permissionsFor(masterAdmin) };
}

export async function getSettingsView(masterAdmin) {
  const [settings, lastEvent, incoming, lastReply, failedReply, pending, failed] = await Promise.all([
    getSettings(),
    WhatsAppWebhookEvent.findOne({ simulated: false }).sort({ receivedAt: -1 }).select('receivedAt eventType status').lean(),
    WhatsAppMessage.findOne({ direction: 'inbound', simulatedInbound: { $ne: true }, providerMessageId: { $not: /^wamid\.SIM\./ } }).sort({ timestamp: -1 }).select('timestamp').lean(),
    WhatsAppMessage.findOne({ origin: 'automation', dryRun: false, acceptedAt: { $ne: null } }).sort({ acceptedAt: -1 }).select('acceptedAt').lean(),
    WhatsAppMessage.findOne({ origin: 'automation', dryRun: false, status: 'failed' }).sort({ failedAt: -1 }).select('failedAt error').lean(),
    WhatsAppWebhookEvent.countDocuments({ status: { $in: ['received', 'processing'] } }),
    WhatsAppWebhookEvent.countDocuments({ status: 'failed' }),
  ]);
  const connection = getConnectionStatus();
  const recentTest = settings.connectionTest;
  const validated = recentTest?.ok && recentTest.phoneNumberId === env.whatsappPhoneNumberId && Date.now() - new Date(recentTest.testedAt).getTime() < 15 * 60 * 1000;
  if (connection.canSendLive) connection.readiness = validated ? 'API_VALIDATED' : 'UNVERIFIED';
  return {
    connection,
    webhook: { lastRealEventAt: lastEvent?.receivedAt || null, lastEventType: lastEvent?.eventType || '', verifyTokenConfigured: Boolean(env.whatsappVerifyToken) },
    diagnostics: {
      lastIncomingAt: incoming?.timestamp || null,
      lastAutoReplyAcceptedAt: lastReply?.acceptedAt || null,
      lastFailedReplyAt: failedReply?.failedAt || null,
      lastReplyError: failedReply?.error || null,
      botEnabled: Boolean(settings.autoReplyEnabled && env.whatsappAutoReplyEnabled),
      pendingEvents: pending, failedEvents: failed,
      worker: { ...getWorkerState(), lastTickAt: settings.workerLastTickAt, lastCompletedAt: settings.workerLastCompletedAt, lastError: settings.workerLastError },
      connectionTest: recentTest || null,
    },
    settings: Object.fromEntries(Object.entries(settings).filter(([key]) => !['workerLeaseToken', 'workerLockedUntil'].includes(key))), permissions: permissionsFor(masterAdmin),
  };
}

export async function testConnection() {
  const result = await checkPhoneNumber();
  await getSettings();
  await WhatsAppSettings.updateOne({ key: 'default' }, { $set: { connectionTest: {
    testedAt: new Date(), ok: result.ok, error: result.ok ? '' : safeError(result.error.message), phoneNumberId: env.whatsappPhoneNumberId,
  } } });
  if (!result.ok) throw new HttpError(result.error.code === 'NOT_READY' || result.error.code === 'DRY_RUN' ? 400 : 502, `Connection check failed: ${result.error.message}`);
  return { ...result.data, apiValidated: true, webhookValidated: false };
}

/** Business-initiated conversation: must use a template (no open 24h window). */
export async function startConversation({ phone, name, templateId, params }, by) {
  const template = await WhatsAppTemplate.findById(assertObjectId(templateId, "template id")).lean();
  if (!template) throw notFound("Template not found");
  const sendability = templateSendability(template);
  if (!sendability.allowed) throw badRequest(sendability.note);

  const contact = await findOrCreateContact({ phone });
  if (contact.optOut) throw badRequest("This contact has opted out of WhatsApp messages");
  if (name && !contact.displayName) {
    contact.displayName = name;
    await contact.save();
  }
  const { conversation } = await getOrOpenConversation(contact);
  if (conversation.status === "New") await WhatsAppConversation.updateOne({ _id: conversation._id }, { $set: { status: "Open" } });
  const message = await createOutbound({
    conversationId: conversation._id,
    contactId: contact._id,
    phone: contact.normalizedPhone,
    template: { name: template.name, language: template.language, params, bodyText: template.bodyText },
    origin: "agent",
    sentBy: by,
  });
  await dispatchMessage(message._id);
  return getConversation(conversation._id);
}

function requireDryRun() {
  if (!isDryRun()) throw new HttpError(403, "Simulation is only available while WHATSAPP_DRY_RUN is on");
}

/** Builds a Meta-shaped payload and runs it through the real webhook pipeline. */
export async function simulateInbound({ phone, text, name }) {
  requireDryRun();
  const id = `wamid.SIM.${crypto.randomUUID()}`;
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: env.whatsappBusinessAccountId || "SIMULATED",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: env.whatsappPhoneNumberId || "SIMULATED" },
              contacts: [{ wa_id: phone, profile: { name: name || "" } }],
              messages: [{ from: phone, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
  const summary = await ingestWebhook(body, { simulated: true });
  await runWorkerTick({ maxCampaignSends: 0 });
  const contactConversation = await WhatsAppMessage.findOne({ providerMessageId: id }).select("conversationId").lean();
  return { summary, providerMessageId: id, conversationId: contactConversation?.conversationId || null };
}

export async function simulateStatus({ providerMessageId, status }) {
  requireDryRun();
  const message = await WhatsAppMessage.findOne({ providerMessageId }).select("dryRun phone").lean();
  if (!message) throw notFound("Message not found");
  if (!message.dryRun) throw badRequest("Only dry-run messages can receive simulated statuses");
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: env.whatsappBusinessAccountId || "SIMULATED",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: env.whatsappPhoneNumberId || "SIMULATED" },
              statuses: [
                {
                  id: providerMessageId,
                  status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: message.phone,
                  ...(status === "failed" ? { errors: [{ code: 131026, title: "Simulated failure (dry run)" }] } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const summary = await ingestWebhook(body, { simulated: true });
  await runWorkerTick({ maxCampaignSends: 0 });
  return summary;
}
