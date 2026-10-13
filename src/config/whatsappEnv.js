// One source for aliases and effective mode. Contradictions fail closed.
export function resolveWhatsappEnv(source = process.env) {
  const value = (...keys) => keys.map((key) => String(source[key] || '').trim()).find(Boolean) || '';
  const mode = value('WHATSAPP_MODE').toLowerCase();
  const dry = value('WHATSAPP_DRY_RUN').toLowerCase();
  const errors = [];
  if (mode && !['live', 'dry_run'].includes(mode)) errors.push('WHATSAPP_MODE must be live or dry_run');
  if (dry && !['true', 'false'].includes(dry)) errors.push('WHATSAPP_DRY_RUN must be true or false');
  if (mode && dry && (mode === 'dry_run') !== (dry === 'true')) errors.push('WHATSAPP_MODE conflicts with WHATSAPP_DRY_RUN');
  const dryRun = mode ? mode === 'dry_run' : dry ? dry === 'true' : source.NODE_ENV !== 'production';
  const version = value('META_GRAPH_API_VERSION', 'WHATSAPP_API_VERSION') || 'v26.0';
  if (!/^v\d+\.\d+$/.test(version)) errors.push('Invalid Meta Graph API version');
  const number = (key, fallback, max) => {
    const n = Number(source[key]);
    return Number.isFinite(n) && n >= 0 ? Math.min(max, n) : fallback;
  };
  return {
    whatsappAccessToken: value('WHATSAPP_ACCESS_TOKEN'),
    whatsappPhoneNumberId: value('WHATSAPP_PHONE_NUMBER_ID'),
    whatsappBusinessAccountId: value('WHATSAPP_BUSINESS_ACCOUNT_ID'),
    whatsappAppId: value('WHATSAPP_APP_ID'),
    whatsappAppSecret: value('WHATSAPP_APP_SECRET'),
    whatsappVerifyToken: value('WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN'),
    whatsappWebhookVerifyToken: value('WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'WHATSAPP_VERIFY_TOKEN'),
    whatsappApiVersion: version,
    whatsappDryRun: dryRun,
    whatsappMode: errors.length ? 'not_ready' : dryRun ? 'dry_run' : 'live',
    whatsappConfigErrors: errors,
    whatsappWebhookUrl: value('WHATSAPP_WEBHOOK_URL'),
    whatsappAutoReplyEnabled: value('WHATSAPP_AUTO_REPLY_ENABLED').toLowerCase() !== 'false',
    whatsappBusinessTimezone: value('WHATSAPP_BUSINESS_TIMEZONE') || 'Asia/Kolkata',
    whatsappSendTimeoutMs: Math.max(1000, number('WHATSAPP_SEND_TIMEOUT_MS', 15000, 30000)),
    whatsappMaxRetries: Math.floor(number('WHATSAPP_MAX_RETRIES', 3, 5)),
    whatsappTestRecipient: value('WHATSAPP_TEST_RECIPIENT'),
  };
}
