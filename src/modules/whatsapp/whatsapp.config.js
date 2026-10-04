import { env } from "../../config/env.js";

/**
 * Non-secret runtime configuration for the General WhatsApp module.
 * Tunables live here as code defaults on purpose — they are not secrets and
 * do not need their own environment variables.
 */
export const WA_CONFIG = Object.freeze({
  graphBaseUrl: "https://graph.facebook.com",
  requestTimeoutMs: 15000,
  maxSendAttempts: 4, // first try + 3 retries for transient errors
  retryBackoffMs: [30_000, 120_000, 600_000], // worker-level backoff between attempts
  inlineRetryDelaysMs: [500, 1500], // quick in-request retries on network/5xx
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
  return Boolean(env.whatsappAccessToken && env.whatsappPhoneNumberId);
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
  else if (!credentials) mode = "not_configured";

  return {
    mode,
    dryRun,
    canSendLive: !dryRun && credentials,
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
