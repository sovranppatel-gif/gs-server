import crypto from "crypto";
import { safeError } from "./whatsapp.security.js";
import { env } from "../../config/env.js";
import { WA_CONFIG, hasSendCredentials, isDryRun, configurationProblems } from "./whatsapp.config.js";

/**
 * Low-level Meta WhatsApp Cloud API client for the General WhatsApp module.
 *
 * It is deliberately separate from src/lib/whatsappCloud.js (used by the
 * Workshop module) so Workshop behaviour can never change because of this
 * module: this client adds dry-run, retries, error classification and
 * interactive/media messages.
 *
 * Every send resolves to { ok, id, dryRun, error?: { code, message, retryable } }.
 * ok=true means Meta ACCEPTED the message; sent/delivered/read arrive later
 * through the webhook.
 */

// Meta error codes worth retrying (rate limits, temporary service errors).
const RETRYABLE_META_CODES = new Set([1, 2, 4, 17, 341, 613, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);



function messagesUrl() {
  return `${WA_CONFIG.graphBaseUrl}/${env.whatsappApiVersion}/${env.whatsappPhoneNumberId}/messages`;
}

function classifyHttpError(status, body) {
  const err = body?.error || {};
  const code = Number(err.code) || status;
  const details = err.error_data?.details || err.message || `HTTP ${status}`;
  const retryable = status >= 500 || status === 429 || RETRYABLE_META_CODES.has(Number(err.code));
  return { code: String(code), message: safeError(details), retryable };
}

async function graphRequest(method, path, payload) {
  const url = path.startsWith("http") ? path : `${WA_CONFIG.graphBaseUrl}/${env.whatsappApiVersion}/${path}`;
  if (new URL(url).origin !== WA_CONFIG.graphBaseUrl) return { ok: false, error: { code: "INVALID_HOST", message: "Invalid Meta API host", retryable: false } };
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${env.whatsappAccessToken}`,
        "Content-Type": "application/json",
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(WA_CONFIG.requestTimeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: classifyHttpError(response.status, data) };
    return { ok: true, data };
  } catch (e) {
    const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    return {
      ok: false,
      error: { code: timeout ? "AMBIGUOUS_TIMEOUT" : "AMBIGUOUS_NETWORK", message: "Meta request outcome unknown; inspect provider status before any manual resend", retryable: method === "GET", ambiguous: method !== "GET" },
    };
  }
}

async function send(payload) {
  const problems = configurationProblems();
  if (problems.length) return { ok: false, dryRun: false, error: { code: "NOT_READY", message: problems.join("; "), retryable: false } };
  if (isDryRun()) {
    // Never contacts Meta. The id is recognisable so webhook simulation can target it.
    return { ok: true, dryRun: true, id: `wamid.DRYRUN.${crypto.randomUUID()}` };
  }
  if (!hasSendCredentials()) {
    return {
      ok: false,
      dryRun: false,
      error: { code: "NOT_CONFIGURED", message: "WhatsApp access token / phone number id not configured", retryable: false },
    };
  }
  const body = { messaging_product: "whatsapp", recipient_type: "individual", ...payload };
  const result = await graphRequest("POST", messagesUrl(), body);
  if (!result.ok) return { ok: false, dryRun: false, error: result.error };
  const id = result.data?.messages?.[0]?.id;
  if (typeof id !== "string" || !id) return { ok: false, dryRun: false, error: { code: "AMBIGUOUS_RESPONSE", message: "Meta accepted HTTP request without a valid message ID; do not automatically resend", retryable: false, ambiguous: true } };
  return { ok: true, dryRun: false, id };
}

/** Template params may not contain newlines, tabs or 4+ consecutive spaces. */
export function cleanTemplateParam(value) {
  return (
    String(value ?? "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/ {4,}/g, "   ")
      .trim()
      .slice(0, 1000) || "-"
  );
}

export function sendText(to, body, { previewUrl = false } = {}) {
  return send({ to, type: "text", text: { preview_url: previewUrl, body: String(body).slice(0, 4096) } });
}

/** `bodyParams` fill {{1}}, {{2}}… in the body; `components` overrides when given. */
export function sendTemplate(to, { name, language = "en", bodyParams = [], components }) {
  const comps =
    components ||
    (bodyParams.length ? [{ type: "body", parameters: bodyParams.map((p) => ({ type: "text", text: cleanTemplateParam(p) })) }] : []);
  return send({ to, type: "template", template: { name, language: { code: language }, components: comps } });
}

/** type: image | document | video | audio; media: { link } or { id }, optional caption/filename. */
export function sendMedia(to, type, media) {
  return send({ to, type, [type]: media });
}

/** Raw interactive object (button / list), per Meta's interactive message schema. */
export function sendInteractive(to, interactive) {
  return send({ to, type: "interactive", interactive });
}

/** Read-only: fetch message templates for the business account. */
export async function fetchTemplates() {
  if (!env.whatsappAccessToken || !env.whatsappBusinessAccountId) {
    return { ok: false, error: { code: "NOT_CONFIGURED", message: "Access token / business account id not configured", retryable: false } };
  }
  const rows = [];
  let next = `${env.whatsappBusinessAccountId}/message_templates?limit=100&fields=id,name,language,status,category,components`;
  for (let page = 0; next && page < 20; page += 1) {
    const result = await graphRequest("GET", next);
    if (!result.ok) return result;
    rows.push(...(result.data?.data || []));
    next = result.data?.paging?.next || null;
  }
  return { ok: true, data: rows };
}

/** Submit a template for Meta review. Blocked in dry-run (it is a write to Meta). */
export async function submitTemplate({ name, language, category, components }) {
  if (isDryRun()) {
    return { ok: false, error: { code: "DRY_RUN", message: "Dry run is on — template was not submitted to Meta", retryable: false } };
  }
  if (!env.whatsappAccessToken || !env.whatsappBusinessAccountId) {
    return { ok: false, error: { code: "NOT_CONFIGURED", message: "Access token / business account id not configured", retryable: false } };
  }
  return graphRequest("POST", `${env.whatsappBusinessAccountId}/message_templates`, { name, language, category, components });
}

/** Lightweight credential check against the phone number object (no message sent). */
export async function checkPhoneNumber() {
  if (isDryRun()) return { ok: false, error: { code: "DRY_RUN", message: "Dry run is enabled; no Meta connection test was made", retryable: false } };
  if (!hasSendCredentials()) return { ok: false, error: { code: "NOT_READY", message: "Live send credentials are missing or conflicting", retryable: false } };
  const result = await graphRequest("GET", `${env.whatsappPhoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
  if (!result.ok) return result;
  const d = result.data || {};
  if (String(d.id || "") !== env.whatsappPhoneNumberId) return { ok: false, error: { code: "INVALID_RESPONSE", message: "Phone identity validation failed", retryable: false } };
  return { ok: true, data: { displayPhoneNumber: d.display_phone_number || "", verifiedName: d.verified_name || "", qualityRating: d.quality_rating || "" } };
}

/**
 * Verifies Meta's X-Hub-Signature-256 against the raw body. Returns
 * { valid, reason }. The public endpoint requires a secret in every environment;
 * authenticated simulation bypasses HTTP and is available only in dry run.
 */
export function verifySignature(rawBody, signatureHeader) {
  if (!env.whatsappAppSecret) {
    return { valid: false, reason: "app_secret_missing" };
  }
  if (!rawBody || !String(signatureHeader || "").startsWith("sha256=")) return { valid: false, reason: "missing_signature" };
  const expected = crypto.createHmac("sha256", env.whatsappAppSecret).update(rawBody).digest("hex");
  const given = String(signatureHeader).slice("sha256=".length);
  if (given.length !== expected.length || !/^[a-f0-9]+$/i.test(given)) return { valid: false, reason: "bad_signature" };
  const valid = crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
  return { valid, reason: valid ? "ok" : "bad_signature" };
}
