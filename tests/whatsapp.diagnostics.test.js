import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBotDiagnostics, getWorkerDiagnostics, getConfigurationDiagnostics } from '../src/modules/whatsapp/whatsapp.diagnostics.js';
import { resolveWhatsappEnv } from '../src/config/whatsappEnv.js';

test('bot diagnostic explains both independent switches without leaking config', () => {
  const config = { whatsappAutoReplyEnabled: false, whatsappAutoReplyConfigured: true, whatsappAccessToken: 'NEVER_RETURN_THIS' };
  const bot = getBotDiagnostics({ autoReplyEnabled: true }, config, 7);
  assert.equal(bot.enabled, false); assert.equal(bot.savedAutoReplyEnabled, true);
  assert.equal(bot.enabledAutomations, 7); assert.match(bot.reasons[0], /WHATSAPP_AUTO_REPLY_ENABLED/);
  assert.ok(!JSON.stringify(bot).includes('NEVER_RETURN_THIS'));
  assert.equal(getBotDiagnostics({ autoReplyEnabled: false }, { ...config, whatsappAutoReplyEnabled: true }, 7).enabled, false);
});

test('missing legacy saved flag fails closed and explains required explicit save', () => {
  const bot = getBotDiagnostics({}, { whatsappAutoReplyEnabled: true }, 7);
  assert.equal(bot.enabled, false); assert.equal(bot.savedAutoReplyEnabled, null);
  assert.match(bot.reasons[0], /missing/);
});

test('environment default and explicit enabled flag are distinguishable', () => {
  assert.equal(resolveWhatsappEnv({}).whatsappAutoReplyEnabled, true);
  assert.equal(resolveWhatsappEnv({}).whatsappAutoReplyConfigured, false);
  const enabled = resolveWhatsappEnv({ WHATSAPP_AUTO_REPLY_ENABLED: 'TRUE' });
  assert.equal(enabled.whatsappAutoReplyEnabled, true); assert.equal(enabled.whatsappAutoReplyConfigured, true);
  assert.equal(resolveWhatsappEnv({ WHATSAPP_AUTO_REPLY_ENABLED: 'false' }).whatsappAutoReplyEnabled, false);
});

const now = Date.UTC(2026, 9, 13, 12);
const state = { running: false, busy: false, lastError: '' };
const runtime = { serverless: true, cronConfigured: true, now };

test('serverless needs cron secret and a heartbeat, not an interval timer', () => {
  assert.equal(getWorkerDiagnostics({}, state, { ...runtime, cronConfigured: false }).status, 'cron_secret_missing');
  assert.equal(getWorkerDiagnostics({}, state, runtime).status, 'no_heartbeat');
  const recent = getWorkerDiagnostics({ workerLastTickAt: new Date(now - 60000) }, state, runtime);
  assert.equal(recent.status, 'recent_tick'); assert.equal(recent.strategy, 'cron'); assert.equal(recent.running, false);
  assert.match(recent.reason, /does not confirm/);
});

test('worker diagnoses stale heartbeat, last failure and stopped persistent worker', () => {
  assert.equal(getWorkerDiagnostics({ workerLastTickAt: new Date(now - 360000) }, state, runtime).status, 'stale');
  assert.equal(getWorkerDiagnostics({ workerLastTickAt: new Date(now), workerLastError: 'Fixture failure' }, state, runtime).status, 'error');
  assert.equal(getWorkerDiagnostics({}, state, { ...runtime, serverless: false }).status, 'stopped');
});

test('cleared durable error overrides an older process-local error', () => {
  assert.equal(getWorkerDiagnostics({ workerLastTickAt: new Date(now), workerLastError: '' }, { ...state, lastError: 'Old error' }, runtime).status, 'recent_tick');
});

test('invalid environment boolean fails closed without returning the invalid value or credentials', () => {
  const config = resolveWhatsappEnv({ WHATSAPP_AUTO_REPLY_ENABLED: 'INVALID_VALUE', WHATSAPP_MODE: 'live', WHATSAPP_DRY_RUN: 'false', WHATSAPP_ACCESS_TOKEN: 'DO_NOT_RETURN' });
  assert.equal(config.whatsappAutoReplyEnabled, false); assert.equal(config.whatsappMode, 'not_ready');
  const view = getConfigurationDiagnostics(config);
  assert.equal(view.autoReplyValid, false); assert.equal(view.modeConfigured, true); assert.equal(view.dryRun, false);
  assert.ok(!JSON.stringify(view).includes('DO_NOT_RETURN')); assert.ok(!JSON.stringify(view).includes('INVALID_VALUE'));
  assert.match(getBotDiagnostics({ autoReplyEnabled: true }, config, 7).reasons.join(' '), /invalid configuration/);
});

test('a manual tick does not prove scheduled work; authenticated cron evidence is tracked separately', () => {
  const settings = { workerLastTickAt: new Date(now), workerLastTrigger: 'admin' };
  const manual = getWorkerDiagnostics(settings, state, runtime);
  assert.equal(manual.status, 'recent_tick'); assert.equal(manual.scheduleStatus, 'not_observed');
  assert.equal(manual.planStatus, 'not_verified');
  const cron = getWorkerDiagnostics({ ...settings, workerLastCronTickAt: new Date(now - 60000) }, state, runtime);
  assert.equal(cron.scheduleStatus, 'recent_tick');
  assert.equal(getWorkerDiagnostics({ ...settings, workerLastCronTickAt: new Date(now - 360000) }, state, runtime).scheduleStatus, 'stale');
});
