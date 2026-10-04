import crypto from "crypto";
import { env } from "../config/env.js";

/**
 * Minimal Meta WhatsApp Cloud API client. Credentials come only from server
 * environment variables and are never returned to the frontend.
 *
 * A successful API response means Meta ACCEPTED the message (it returns a
 * message id). Actual sent/delivered/read status only arrives later through
 * the webhook — callers must not treat acceptance as delivery.
 */

export function isWhatsappConfigured() {
  return Boolean(env.whatsappAccessToken && env.whatsappPhoneNumberId);
}

export function whatsappConfigStatus() {
  return {
    configured: isWhatsappConfigured(),
    apiVersion: env.whatsappApiVersion,
    webhookConfigured: Boolean(env.whatsappWebhookVerifyToken),
    signatureCheck: Boolean(env.whatsappAppSecret),
  };
}

async function postMessage(payload) {
  const url = `https://graph.facebook.com/${env.whatsappApiVersion}/${env.whatsappPhoneNumberId}/messages`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.whatsappAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = data?.error;
      return {
        ok: false,
        error: err ? `${err.code || response.status}: ${err.error_data?.details || err.message || "Request failed"}` : `HTTP ${response.status}`,
      };
    }
    return { ok: true, id: data?.messages?.[0]?.id || "" };
  } catch (err) {
    return { ok: false, error: err?.name === "TimeoutError" ? "Request timed out" : err?.message || "Network error" };
  }
}

export function sendWhatsappText(to, body) {
  return postMessage({ to, type: "text", text: { preview_url: true, body: String(body).slice(0, 4096) } });
}

/** Template params may not contain newlines, tabs or 4+ consecutive spaces. */
function cleanTemplateParam(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {4,}/g, "   ")
    .trim()
    .slice(0, 1000) || "-";
}

export function sendWhatsappTemplate(to, { name, language, params = [] }) {
  const components = params.length
    ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: cleanTemplateParam(p) })) }]
    : [];
  return postMessage({
    to,
    type: "template",
    template: { name, language: { code: language || "en" }, components },
  });
}

/** Verifies Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!env.whatsappAppSecret) return true; // signature check disabled when no secret is set
  if (!rawBody || !signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", env.whatsappAppSecret).update(rawBody).digest("hex");
  const given = signatureHeader.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}
