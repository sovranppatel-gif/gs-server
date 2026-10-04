import dotenv from "dotenv";

dotenv.config();

const required = (name, fallback = null) => {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== null) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
};

export const env = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  mongoUri: required("MONGO_URI", "mongodb://127.0.0.1:27017/growskillstech"),
  jwtSecret: required("JWT_SECRET", "dev-only-change-me-use-strong-secret-in-production"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "1d",
  masterAdminEmail: (process.env.MASTER_ADMIN_EMAIL || "admin@scholarsmediatech.com").toLowerCase().trim(),
  masterAdminPassword: process.env.MASTER_ADMIN_PASSWORD || "",
  masterAdminPasswordHash: process.env.MASTER_ADMIN_PASSWORD_HASH || "",
  // Brevo SMTP
  smtpHost: process.env.SMTP_HOST || "smtp-relay.brevo.com",
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpSecure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  emailFrom:
    process.env.EMAIL_FROM || "Grow Skills Tech <noreply@growskillstech.com>",
  clientUrl: process.env.CLIENT_URL || "http://localhost:5173",
  // OTP
  otpLength: Number(process.env.OTP_LENGTH) || 6,
  otpExpiryMinutes: Number(process.env.OTP_EXPIRY_MINUTES) || 5,
  // WhatsApp Cloud API (Meta) — optional; workshop reminders are disabled without them
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  whatsappApiVersion: process.env.WHATSAPP_API_VERSION || "v21.0",
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET || "",
  whatsappWebhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "",
  // General WhatsApp module (src/modules/whatsapp). Dry run is ON unless explicitly "false".
  whatsappBusinessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "",
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "",
  whatsappDryRun: String(process.env.WHATSAPP_DRY_RUN ?? "true").trim().toLowerCase() !== "false",
  // Shared secret for the serverless queue tick (Vercel Cron sends it as a Bearer token)
  cronSecret: process.env.CRON_SECRET || "",
};

if (env.jwtSecret.length < 32 && env.nodeEnv === "production") {
  throw new Error("JWT_SECRET must be at least 32 characters in production");
}

if ((!env.smtpUser || !env.smtpPass) && env.nodeEnv === "production") {
  throw new Error("SMTP_USER and SMTP_PASS are required in production for email OTP");
}
