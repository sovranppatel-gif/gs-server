import { env } from '../../config/env.js';

/** Logs/diagnostics must not contain credentials, phone numbers or customer input. */
export function safeError(error) {
  if (error?.name === 'ValidationError' || error?.name === 'CastError') return 'Invalid data; inspect the record in the authenticated admin interface';
  let text = String(error?.message || error || 'Operation failed');
  for (const secret of [env.whatsappAccessToken, env.whatsappAppSecret, env.whatsappVerifyToken, env.cronSecret]) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(?:mongodb(?:\+srv)?:\/\/|https?:\/\/)[^\s]+/gi, '[URL]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\b\d{7,}\b/g, '[NUMBER]').slice(0, 300);
}
