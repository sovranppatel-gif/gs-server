import { normalizeWaPhone } from "./whatsapp.phone.js";
import { badRequest, cleanString } from "./whatsapp.utils.js";

export function validateSimulatedInbound(body = {}) {
  const phone = normalizeWaPhone(body.phone);
  if (!phone) throw badRequest("Enter a valid WhatsApp number");
  const text = cleanString(body.text, 4096);
  if (!text) throw badRequest("Message text is required");
  return { phone, text, name: cleanString(body.name, 120) };
}

export function validateSimulatedStatus(body = {}) {
  const status = String(body.status || "");
  if (!["sent", "delivered", "read", "failed"].includes(status)) throw badRequest("Status must be sent, delivered, read or failed");
  const providerMessageId = cleanString(body.providerMessageId, 200);
  if (!providerMessageId) throw badRequest("providerMessageId is required");
  return { status, providerMessageId };
}

export function validateStartConversation(body = {}) {
  const phone = normalizeWaPhone(body.phone);
  if (!phone) throw badRequest("Enter a valid WhatsApp number");
  if (!body.templateId) throw badRequest("A new conversation must start with an approved template");
  return {
    phone,
    name: cleanString(body.name, 120),
    templateId: body.templateId,
    params: (Array.isArray(body.params) ? body.params : []).map((p) => cleanString(p, 1000)),
  };
}
