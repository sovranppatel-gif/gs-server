import { env } from "../../config/env.js";

/**
 * Non-secret runtime configuration for the General WhatsApp module.
 * Tunables live here as code defaults on purpose — they are not secrets and
 * do not need their own environment variables.
 */
export const WA_CONFIG = Object.freeze({
  graphBaseUrl: "https://graph.facebook.com",
  requestTimeoutMs: env.whatsappSendTimeoutMs,
  maxSendAttempts: 1 + env.whatsappMaxRetries,
  retryBackoffMs: [30_000, 120_000, 600_000], // worker-level backoff between attempts
  customerServiceWindowMs: 24 * 60 * 60 * 1000,
  workerPollMs: 5000,
  workerLeaseMs: 60_000,
  webhookEventTtlDays: 90,
  defaultCountryCode: "91",
});

export function isDryRun() {
  return env.whatsappDryRun;
}

export function hasSendCredentials() {
  return !env.whatsappConfigErrors.length && Boolean(env.whatsappAccessToken && env.whatsappPhoneNumberId);
}

export function configurationProblems() {
  const missing = [...env.whatsappConfigErrors];
  if (!isDryRun()) {
    for (const [key, value] of [['WHATSAPP_ACCESS_TOKEN', env.whatsappAccessToken], ['WHATSAPP_PHONE_NUMBER_ID', env.whatsappPhoneNumberId], ['WHATSAPP_BUSINESS_ACCOUNT_ID', env.whatsappBusinessAccountId], ['WHATSAPP_APP_SECRET', env.whatsappAppSecret], ['WHATSAPP_VERIFY_TOKEN', env.whatsappVerifyToken]]) {
      if (!value) missing.push(`${key} is missing`);
    }
  }
  if (env.whatsappWebhookUrl) {
    try {
      const url = new URL(env.whatsappWebhookUrl);
      if (url.protocol !== 'https:' || url.pathname !== '/api/whatsapp/webhook' || url.search || url.hash || url.username || url.password) missing.push('WHATSAPP_WEBHOOK_URL must be the public HTTPS /api/whatsapp/webhook URL');
    } catch { missing.push('Invalid WHATSAPP_WEBHOOK_URL'); }
  } else if (env.nodeEnv === 'production' && !isDryRun()) missing.push('WHATSAPP_WEBHOOK_URL is missing');
  return missing;
}

export function isProduction() {
  return env.nodeEnv === "production";
}

/**
 * Safe-to-return status. Secrets are reported only as configured / not
 * configured — their values never leave this process.
 */
export function getConnectionStatus() {
  const dryRun = isDryRun();
  const credentials = hasSendCredentials();
  let mode = "live";
  if (dryRun) mode = "dry_run";
  const problems = configurationProblems();
  if (problems.length) mode = "not_ready";

  return {
    mode,
    dryRun,
    canSendLive: !dryRun && credentials && !problems.length,
    readiness: problems.length ? 'NOT_READY' : dryRun ? 'DRY_RUN' : 'UNVERIFIED',
    problems,
    webhookUrl: env.whatsappWebhookUrl,
    autoReplyAllowed: env.whatsappAutoReplyEnabled,
    apiVersion: env.whatsappApiVersion,
    phoneNumberId: env.whatsappPhoneNumberId || "",
    businessAccountId: env.whatsappBusinessAccountId || "",
    webhookPath: "/api/whatsapp/webhook",
    secrets: {
      accessToken: env.whatsappAccessToken ? "Configured" : "Not Configured",
      verifyToken: env.whatsappVerifyToken ? "Configured" : "Not Configured",
      appSecret: env.whatsappAppSecret ? "Configured" : "Not Configured",
    },
    signatureVerification: env.whatsappAppSecret
      ? "enabled"
      : isProduction()
        ? "blocking (app secret missing in production)"
        : "disabled (development only)",
    cronTick: env.cronSecret ? "Configured" : "Not Configured",
    runtime: process.env.VERCEL ? "serverless" : "server",
  };
}
