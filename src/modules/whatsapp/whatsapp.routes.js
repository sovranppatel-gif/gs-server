import { Router } from "express";
import { requireMasterAdminJwt } from "../../middleware/requireMasterAdminJwt.js";
import { WA_PERMISSIONS as P, requireWhatsappPermission as can } from "./whatsapp.permissions.js";
import * as c from "./whatsapp.controller.js";

/**
 * /api/whatsapp — General WhatsApp module (independent of Workshop WhatsApp).
 * Public: the Meta webhook (signature-verified) and the cron tick (shared
 * secret). Everything else requires the Master Admin JWT.
 */
const router = Router();

// Public
router.get("/webhook", c.webhookVerify);
router.post("/webhook", c.webhookReceive);
router.get("/cron/tick", c.cronTick);
router.post("/cron/tick", c.cronTick);

router.use(requireMasterAdminJwt);

router.get("/status", can(P.VIEW), c.getStatus);

// Conversations / inbox
router.get("/conversations", can(P.VIEW), c.listConversations);
router.post("/conversations/start", can(P.SEND), c.startConversation);
router.get("/conversations/:id", can(P.VIEW), c.getConversation);
router.get("/conversations/:id/messages", can(P.VIEW), c.getConversationMessages);
router.post("/conversations/:id/read", can(P.VIEW), c.markConversationRead);
router.patch("/conversations/:id", can(P.SEND), c.updateConversation);
router.post("/conversations/:id/reply", can(P.SEND), c.replyToConversation);
router.post("/conversations/:id/handover", can(P.SEND), c.handoverConversation);
router.post("/conversations/:id/resume", can(P.SEND), c.resumeAutomation);

// Contacts
router.get("/contacts", can(P.VIEW), c.listContacts);
router.post("/contacts", can(P.SEND), c.createContact);
router.get("/contacts/:id", can(P.VIEW), c.getContact);
router.patch("/contacts/:id", can(P.SEND), c.updateContact);
router.post("/contacts/:id/resolve", can(P.VIEW), c.resolveContact);
router.post("/contacts/:id/opt-out", can(P.SEND), c.optOutContact);
router.post("/contacts/:id/opt-in", can(P.SEND), c.optInContact);
router.get("/tags", can(P.VIEW), c.listTags);
router.get("/staff-options", can(P.VIEW), c.staffOptions);

// Message history
router.get("/messages", can(P.VIEW), c.listMessages);
router.post("/messages/:id/retry", can(P.SEND), c.retryMessage);

// Automations
router.get("/automations", can(P.AUTOMATION), c.listAutomations);
router.post("/automations", can(P.AUTOMATION), c.createAutomation);
router.post("/automations/test", can(P.AUTOMATION), c.testAutomation);
router.get("/automations/:id", can(P.AUTOMATION), c.getAutomation);
router.patch("/automations/:id", can(P.AUTOMATION), c.updateAutomation);
router.delete("/automations/:id", can(P.AUTOMATION), c.deleteAutomation);

// Templates
router.get("/templates", can(P.VIEW), c.listTemplates);
router.post("/templates", can(P.TEMPLATES), c.createTemplate);
router.post("/templates/sync", can(P.TEMPLATES), c.syncTemplates);
router.get("/templates/:id", can(P.VIEW), c.getTemplate);
router.patch("/templates/:id", can(P.TEMPLATES), c.updateTemplate);
router.delete("/templates/:id", can(P.TEMPLATES), c.deleteTemplate);
router.post("/templates/:id/submit", can(P.TEMPLATES), c.submitTemplate);

// Audience + campaigns (bulk & scheduled)
router.get("/audience/options", can(P.BULK_SEND), c.audienceOptions);
router.post("/audience/preview", can(P.BULK_SEND), c.previewCampaign);
router.get("/campaigns", can(P.CAMPAIGNS), c.listCampaigns);
router.post("/campaigns", can(P.BULK_SEND), c.createCampaign);
router.get("/campaigns/:id", can(P.CAMPAIGNS), c.getCampaign);
router.get("/campaigns/:id/recipients", can(P.CAMPAIGNS), c.listRecipients);
router.get("/campaigns/:id/export", can(P.CAMPAIGNS), c.exportCampaign);
router.post("/campaigns/:id/pause", can(P.CAMPAIGNS), c.pauseCampaign);
router.post("/campaigns/:id/resume", can(P.CAMPAIGNS), c.resumeCampaign);
router.post("/campaigns/:id/cancel", can(P.CAMPAIGNS), c.cancelCampaign);
router.post("/campaigns/:id/retry-failed", can(P.BULK_SEND), c.retryFailedCampaign);
router.delete("/campaigns/:id", can(P.CAMPAIGNS), c.deleteCampaign);

// Reports & settings
router.get("/reports", can(P.VIEW), c.getReport);
router.get("/settings", can(P.VIEW), c.getSettings);
router.patch("/settings", can(P.SETTINGS), c.updateSettings);
router.post("/settings/test-connection", can(P.SETTINGS), c.testConnection);
router.get("/webhook-events", can(P.SETTINGS), c.webhookEvents);
router.post('/webhook-events/:id/retry', can(P.SETTINGS), c.retryEvent);
router.post("/worker/run", can(P.SETTINGS), c.runWorker);

// Dry-run only
router.post("/simulate/inbound", can(P.SETTINGS), c.simulateInbound);
router.post("/simulate/status", can(P.SETTINGS), c.simulateStatus);

export default router;
