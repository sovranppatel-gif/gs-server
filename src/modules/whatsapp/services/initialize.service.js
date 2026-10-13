import { WhatsAppContact } from '../models/whatsappContact.model.js';
import { WhatsAppConversation } from '../models/whatsappConversation.model.js';
import { WhatsAppMessage } from '../models/whatsappMessage.model.js';
import { WhatsAppWebhookEvent } from '../models/whatsappWebhookEvent.model.js';
import { WhatsAppAutomation } from '../models/whatsappAutomation.model.js';
import { WhatsAppSettings } from '../models/whatsappSettings.model.js';
import { ensureDefaultAutomations } from './automation.service.js';

let ready;
export function initializeWhatsapp() {
  if (!ready) ready = (async () => {
    // Additive indexes only. Never syncIndexes/drop collections or alter customer data.
    for (const model of [WhatsAppContact, WhatsAppConversation, WhatsAppMessage, WhatsAppWebhookEvent, WhatsAppAutomation, WhatsAppSettings]) {
      await model.createIndexes();
    }
    await ensureDefaultAutomations();
  })().catch((error) => { ready = null; throw error; });
  return ready;
}
