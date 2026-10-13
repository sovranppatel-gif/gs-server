/** Read-only diagnostics. Bot controls and delivery readiness are separate. */
export function getBotDiagnostics(settings, config, enabledAutomations) {
  const savedAutoReplyEnabled = typeof settings?.autoReplyEnabled === 'boolean' ? settings.autoReplyEnabled : null;
  const environmentEnabled = config.whatsappAutoReplyEnabled === true;
  const enabled = Boolean(savedAutoReplyEnabled && environmentEnabled);
  const reasons = [];
  if (config.whatsappAutoReplyValid === false) reasons.push('WHATSAPP_AUTO_REPLY_ENABLED must be true or false; automatic replies are blocked by invalid configuration.');
  else if (!environmentEnabled) reasons.push('WHATSAPP_AUTO_REPLY_ENABLED disables automatic replies in this backend deployment.');
  if (savedAutoReplyEnabled === false) reasons.push('Auto replies are disabled in saved WhatsApp settings. Enable the checkbox and save settings.');
  if (savedAutoReplyEnabled === null) reasons.push('The saved auto-reply flag is missing. Explicitly choose and save the setting.');
  return {
    enabled,
    status: savedAutoReplyEnabled === null ? 'unavailable' : enabled ? 'enabled' : 'disabled',
    environmentEnabled,
    environmentFlagConfigured: config.whatsappAutoReplyConfigured === true,
    savedAutoReplyEnabled,
    enabledAutomations,
    reasons,
  };
}

export function getWorkerDiagnostics(settings, state, { serverless, cronConfigured, now = Date.now() }) {
  const lastTickAt = settings.workerLastTickAt === undefined ? state.lastTickAt || null : settings.workerLastTickAt;
  const lastCompletedAt = settings.workerLastCompletedAt === undefined ? state.lastCompletedAt || null : settings.workerLastCompletedAt;
  const tickTime = lastTickAt ? new Date(lastTickAt).getTime() : NaN;
  const heartbeatAgeMs = Number.isFinite(tickTime) ? Math.max(0, now - tickTime) : null;
  const lastError = settings.workerLastError ?? state.lastError ?? '';
  let status, reason;
  if (serverless && !cronConfigured) {
    status = 'cron_secret_missing';
    reason = 'CRON_SECRET is missing in this deployment; the serverless queue tick cannot run.';
  } else if (!serverless && !state.running) {
    status = 'stopped';
    reason = 'The in-process queue worker is not running.';
  } else if (lastError) {
    status = 'error';
    reason = 'The last worker run failed. Check the sanitized worker error and failed webhook events.';
  } else if (heartbeatAgeMs === null) {
    status = 'no_heartbeat';
    reason = serverless ? 'No queue tick has been recorded. Check Vercel Cron scheduling and authorization.' : 'Waiting for the first queue tick.';
  } else if (heartbeatAgeMs > 5 * 60 * 1000) {
    status = 'stale';
    reason = 'No queue tick in the last five minutes. Check the worker or cron logs.';
  } else {
    status = 'recent_tick';
    reason = 'A recent queue tick is recorded. This does not confirm message delivery or the source of the tick.';
  }
  const lastCronTickAt = settings.workerLastCronTickAt || null;
  const cronTime = lastCronTickAt ? new Date(lastCronTickAt).getTime() : NaN;
  const scheduleStatus = !serverless ? 'not_applicable' : !cronConfigured ? 'blocked' : !Number.isFinite(cronTime) ? 'not_observed' : now - cronTime > 5 * 60 * 1000 ? 'stale' : 'recent_tick';
  const scheduleReason = !serverless ? 'Persistent servers use the interval worker.' : !cronConfigured ? 'CRON_SECRET is missing.' : !Number.isFinite(cronTime)
    ? 'No authenticated cron tick is recorded. A manual queue run does not verify scheduled processing. Check the deployed Vercel plan and Cron logs.'
    : scheduleStatus === 'stale' ? 'No authenticated cron tick in the last five minutes. Check Cron logs and scheduling.'
    : 'A recent authenticated cron tick is recorded; this does not confirm future scheduling or delivery.';
  return { ...state, strategy: serverless ? 'cron' : 'interval', status, reason, heartbeatAgeMs, lastTickAt, lastCompletedAt, lastError,
    lastTrigger: settings.workerLastTrigger || 'unknown', lastCronTickAt, lastCronCompletedAt: settings.workerLastCronCompletedAt || null,
    scheduleStatus, scheduleReason, planStatus: serverless ? 'not_verified' : 'not_applicable',
  };
}

export function getConfigurationDiagnostics(config) {
  return {
    autoReplyEnabled: config.whatsappAutoReplyEnabled === true,
    autoReplyConfigured: config.whatsappAutoReplyConfigured === true,
    autoReplyValid: config.whatsappAutoReplyValid !== false,
    mode: config.whatsappMode,
    modeConfigured: config.whatsappModeConfigured === true,
    dryRun: config.whatsappDryRun === true,
    dryRunConfigured: config.whatsappDryRunConfigured === true,
    problems: [...config.whatsappConfigErrors],
  };
}
