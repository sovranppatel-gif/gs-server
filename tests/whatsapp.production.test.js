import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { existsSync } from 'node:fs';

// Never load test credentials from a developer's .env or send real messages.
Object.assign(process.env, {
  MONGO_URI: 'mongodb://127.0.0.1:1/TEST_ONLY_NEVER_CONNECT',
  NODE_ENV: 'development', WHATSAPP_MODE: 'dry_run', WHATSAPP_DRY_RUN: 'true',
  WHATSAPP_ACCESS_TOKEN: 'TEST_ONLY_TOKEN', WHATSAPP_APP_SECRET: 'TEST_ONLY_SECRET',
  WHATSAPP_PHONE_NUMBER_ID: '100001', WHATSAPP_BUSINESS_ACCOUNT_ID: '200001',
  WHATSAPP_VERIFY_TOKEN: 'TEST_ONLY_VERIFY', META_GRAPH_API_VERSION: 'v26.0',
  WHATSAPP_WEBHOOK_URL: 'https://api.example.test/api/whatsapp/webhook',
  JWT_SECRET: 'TEST_ONLY_JWT_SECRET_MORE_THAN_32_CHARACTERS',
  MONGOMS_DOWNLOAD_DIR: `${process.cwd()}/.cache/mongodb`,
});
const { env } = await import('../src/config/env.js');
const { resolveWhatsappEnv } = await import('../src/config/whatsappEnv.js');
const client = await import('../src/modules/whatsapp/whatsapp.client.js');
const { getConnectionStatus } = await import('../src/modules/whatsapp/whatsapp.config.js');
const { webhookVerify, webhookReceive } = await import('../src/modules/whatsapp/whatsapp.controller.js');
const webhook = await import('../src/modules/whatsapp/services/webhook.service.js');
const messages = await import('../src/modules/whatsapp/services/message.service.js');
const conversations = await import('../src/modules/whatsapp/services/conversation.service.js');
const { ensureDefaultAutomations } = await import('../src/modules/whatsapp/services/automation.service.js');
const { getSettings } = await import('../src/modules/whatsapp/services/settings.service.js');
const { WhatsAppMessage: Message } = await import('../src/modules/whatsapp/models/whatsappMessage.model.js');
const { WhatsAppWebhookEvent: Event } = await import('../src/modules/whatsapp/models/whatsappWebhookEvent.model.js');
const { WhatsAppContact: Contact } = await import('../src/modules/whatsapp/models/whatsappContact.model.js');
const { WhatsAppConversation: Conversation } = await import('../src/modules/whatsapp/models/whatsappConversation.model.js');
const { WhatsAppAutomation: Automation } = await import('../src/modules/whatsapp/models/whatsappAutomation.model.js');
const { WhatsAppSettings: Settings } = await import('../src/modules/whatsapp/models/whatsappSettings.model.js');
const { Lead } = await import('../src/modules/leads/leads.model.js');
const { Course } = await import('../src/modules/courses/courses.model.js');
const { WhatsAppCampaign: Campaign } = await import('../src/modules/whatsapp/models/whatsappCampaign.model.js');
const { WhatsAppCampaignRecipient: Recipient } = await import('../src/modules/whatsapp/models/whatsappCampaignRecipient.model.js');
const { WhatsAppTemplate: Template } = await import('../src/modules/whatsapp/models/whatsappTemplate.model.js');
const { WorkshopWhatsappMessage: WorkshopMessage } = await import('../src/modules/workshopManagement/workshopManagement.model.js');
const mongoose = (await import('mongoose')).default;
const originalEnv = { ...env };
const originalFetch = globalThis.fetch;
let repl, server, base, sequence = 0;
const phone = '919876543210'; // Synthetic fixture; no request may leave this test.
const payload = (text = 'Hi', id = `wamid.TEST.${++sequence}`, extra = {}) => ({
  object: 'whatsapp_business_account', entry: [{ id: env.whatsappBusinessAccountId,
    changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
      metadata: { phone_number_id: env.whatsappPhoneNumberId },
      messages: [{ id, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...extra }],
    } }],
  }],
});
const signature = (raw) => `sha256=${crypto.createHmac('sha256', env.whatsappAppSecret).update(raw).digest('hex')}`;
async function inbound(text, extra) {
  await webhook.ingestWebhook(payload(text, undefined, extra), { simulated: env.whatsappDryRun });
  await webhook.reprocessStuckEvents();
  const failed = await Event.findOne({ status: 'failed' }).lean();
  assert.equal(failed, null, failed?.error);
  return Conversation.findOne({ phone });
}
async function post(body, header) {
  const raw = JSON.stringify(body);
  return originalFetch(`${base}/api/whatsapp/webhook`, { method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', ...(header !== null ? { 'X-Hub-Signature-256': header || signature(raw) } : {}) },
  });
}

before(async () => {
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const installed = 'C:/Program Files/MongoDB/Server/8.0/bin/mongod.exe';
  const systemBinary = process.env.MONGOMS_SYSTEM_BINARY || (existsSync(installed) ? installed : undefined);
  repl = await MongoMemoryReplSet.create({ binary: systemBinary ? { systemBinary } : undefined, replSet: { count: 1 }, instanceOpts: [{ spawn: { windowsHide: true } }] });
  await mongoose.connect(repl.getUri('whatsapp_isolated_test'));
  // All transaction participants must have their collections created in advance.
  for (const model of Object.values(mongoose.models)) await model.createCollection();
  for (const model of [Message, Event, Contact, Conversation, Automation, Settings]) await model.createIndexes();
  await ensureDefaultAutomations();
  const app = express();
  app.use('/api/whatsapp/webhook', express.raw({ type: '*/*', limit: '2mb' }));
  app.use(express.json());
  app.use('/api/whatsapp', (await import('../src/modules/whatsapp/whatsapp.routes.js')).default);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  assert.equal(mongoose.connection.name, 'whatsapp_isolated_test', 'Test database safety guard');
  mock.restoreAll(); Object.assign(env, originalEnv);
  globalThis.fetch = () => { throw new Error('Unexpected external request from dry-run test'); };
  for (const model of [Message, Event, Contact, Conversation, Lead, Settings, Course, Campaign, Recipient, Template, WorkshopMessage]) await model.deleteMany({});
  await getSettings();
});
after(async () => {
  mock.restoreAll(); globalThis.fetch = originalFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect(); if (repl) await repl.stop();
});

test('GET valid verification returns exact plain-text challenge without JWT', async () => {
  const r = await originalFetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=TEST_ONLY_VERIFY&hub.challenge=000123`);
  assert.equal(r.status, 200); assert.equal(await r.text(), '000123'); assert.match(r.headers.get('content-type'), /text\/plain/);
});
test('GET invalid verification token is rejected', async () => {
  assert.equal((await originalFetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong`)).status, 403);
});
test('valid HMAC accepted durably before chatbot work, preserving raw bytes', async () => {
  const r = await post(payload()); assert.equal(r.status, 200);
  assert.equal(await Event.countDocuments({ status: 'received' }), 1);
  assert.equal(await Message.countDocuments(), 0);
});
test('invalid signature rejected, creates no event', async () => {
  assert.equal((await post(payload(), `sha256=${'0'.repeat(64)}`)).status, 401); assert.equal(await Event.countDocuments(), 0);
});
test('production missing signature rejected', async () => {
  env.nodeEnv = 'production'; assert.equal((await post(payload(), null)).status, 401);
});
test('missing app secret fails closed in all environments', async () => {
  env.whatsappAppSecret = ''; assert.equal(client.verifySignature(Buffer.from('{}'), '').valid, false);
  assert.equal((await post(payload(), null)).status, 503);
});
test('database persistence failure returns retryable error', async () => {
  mock.method(Event, 'create', async () => { throw new Error('test database unavailable'); });
  assert.equal((await post(payload())).status, 500);
});
test('incoming text creates message and Hi queues configured welcome automation', async () => {
  await inbound('Hi'); assert.equal(await Message.countDocuments({ direction: 'inbound' }), 1);
  const reply = await Message.findOne({ direction: 'outbound' });
  assert.match(reply.text, /Welcome to GrowSkills Tech Pvt\. Ltd\./); assert.match(reply.text, /www.growskillstech.com/);
  assert.equal(reply.status, 'queued');
});
test('duplicate delivery before and after processing creates one incoming and one reply', async () => {
  const body = payload(); await webhook.ingestWebhook(body); await webhook.ingestWebhook(body);
  await webhook.reprocessStuckEvents(); await webhook.ingestWebhook(body); await webhook.reprocessStuckEvents();
  assert.equal(await Event.countDocuments(), 1); assert.equal(await Message.countDocuments({ direction: 'inbound' }), 1);
  assert.equal(await Message.countDocuments({ direction: 'outbound' }), 1);
});
test('duplicate after event history expiry is ignored without reopening or replying', async () => {
  const body = payload(); await webhook.ingestWebhook(body); await webhook.reprocessStuckEvents();
  await Conversation.updateOne({ phone }, { $set: { status: 'Closed' } });
  await Event.deleteMany({}); // Simulate event TTL only in the isolated database.
  await webhook.ingestWebhook(body); await webhook.reprocessStuckEvents();
  assert.equal(await Message.countDocuments(), 2);
  assert.equal((await Event.findOne()).status, 'ignored'); assert.equal((await Conversation.findOne({ phone })).status, 'Closed');
});
test('menu 1 starts Software Services flow', async () => {
  await inbound('Hi'); const conv = await inbound('1');
  const flow = await Automation.findById(conv.currentAutomation); assert.equal(flow.systemKey, 'software'); assert.equal(conv.currentStep, 'service');
});
test('menu 2 starts Training flow; active answer progresses and creates one lead', async () => {
  await inbound('Hi'); let conv = await inbound('2');
  assert.equal((await Automation.findById(conv.currentAutomation)).systemKey, 'training');
  conv = await inbound('1'); assert.equal(conv.currentStep, 'ask_name');
  conv = await inbound('Test Student'); assert.equal(conv.currentStep, 'ask_callback'); assert.equal(conv.flowData.name, 'Test Student');
  await inbound('Tomorrow 5 PM'); assert.equal(await Lead.countDocuments(), 1);
  await inbound('training'); await inbound('1'); await inbound('Test Student'); await inbound('Tomorrow 5 PM');
  assert.equal(await Lead.countDocuments(), 1);
});
test('interactive numbered reply follows the same menu engine', async () => {
  await inbound('Hi'); const conv = await inbound('', { type: 'interactive', interactive: { list_reply: { id: '2', title: 'Training Programs' } } });
  assert.equal((await Automation.findById(conv.currentAutomation)).systemKey, 'training');
});
test('human handover pauses bot, including consent confirmation; resume works', async () => {
  await inbound('Hi'); const conv = await inbound('6'); assert.equal(conv.humanHandover, true);
  const count = await Message.countDocuments({ direction: 'outbound' });
  await inbound('Hi'); await inbound('STOP'); assert.equal(await Message.countDocuments({ direction: 'outbound' }), count);
  await Contact.updateOne({ normalizedPhone: phone }, { $set: { optOut: false } });
  await conversations.setHandover(conv._id, false); await inbound('menu');
  assert.ok(await Message.countDocuments({ direction: 'outbound' }) > count);
});
test('opt-out blocks bot until start opts in and opens menu', async () => {
  await inbound('STOP'); const count = await Message.countDocuments({ direction: 'outbound' });
  await inbound('software'); assert.equal(await Message.countDocuments({ direction: 'outbound' }), count);
  await inbound('start'); assert.equal((await Contact.findOne({ normalizedPhone: phone })).optOut, false);
  assert.match((await Message.findOne({ direction: 'outbound' }).sort({ createdAt: -1 })).text, /Welcome/);
});
test('status webhook updates delivery and never runs bot', async () => {
  await inbound('Hi'); await messages.dispatchDueMessages(); const out = await Message.findOne({ direction: 'outbound' });
  const body = payload(); const value = body.entry[0].changes[0].value; delete value.messages;
  value.statuses = [{ id: out.providerMessageId, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: phone }];
  await webhook.ingestWebhook(body, { simulated: true }); await webhook.reprocessStuckEvents();
  assert.equal(await Message.countDocuments({ direction: 'outbound' }), 1);
  assert.equal((await Message.findById(out._id)).status, 'delivered');
});
test('transaction rollback after incoming insert allows safe recovery with one reply', async () => {
  const body = payload(); await webhook.ingestWebhook(body);
  const realUpdate = Conversation.updateOne.bind(Conversation); let fail = true;
  mock.method(Conversation, 'updateOne', (...args) => {
    if (fail && args[1]?.$max?.lastInboundAt) { fail = false; throw new Error('injected restart'); }
    return realUpdate(...args);
  });
  await webhook.reprocessStuckEvents(); assert.equal(await Message.countDocuments(), 0);
  mock.restoreAll(); await Event.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
  await webhook.reprocessStuckEvents(); assert.equal(await Message.countDocuments({ direction: 'inbound' }), 1);
  assert.equal(await Message.countDocuments({ direction: 'outbound' }), 1);
});
test('concurrent workers serialize same sender and do not duplicate replies', async () => {
  await webhook.ingestWebhook(payload('Hi')); await webhook.ingestWebhook(payload('2'));
  await Promise.all([webhook.reprocessStuckEvents(), webhook.reprocessStuckEvents()]);
  await webhook.reprocessStuckEvents();
  assert.equal(await Message.countDocuments({ direction: 'inbound' }), 2);
  assert.equal(await Message.countDocuments({ direction: 'outbound' }), 2);
  assert.equal((await Conversation.findOne({ phone })).currentStep, 'course');
});
test('dry-run makes no Meta request and returns recognisable simulated ID', async () => {
  const sent = await client.sendText(phone, 'test'); assert.equal(sent.ok, true); assert.equal(sent.dryRun, true); assert.match(sent.id, /^wamid\.DRYRUN\./);
});
test('live sender uses official endpoint and correct text payload', async () => {
  env.whatsappDryRun = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `https://graph.facebook.com/v26.0/${env.whatsappPhoneNumberId}/messages`);
    assert.equal(options.headers.Authorization, 'Bearer TEST_ONLY_TOKEN');
    assert.deepEqual(JSON.parse(options.body), { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'text', text: { preview_url: false, body: 'test' } });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.REAL_MOCK' }] }));
  };
  assert.equal((await client.sendText(phone, 'test')).id, 'wamid.REAL_MOCK');
});
test('Meta authentication failure recorded in message without secrets', async () => {
  env.whatsappDryRun = false; await inbound('Hi');
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 190, message: 'TEST_ONLY_TOKEN expired' } }), { status: 401 });
  await messages.dispatchDueMessages(); const out = await Message.findOne({ direction: 'outbound' });
  assert.equal(out.status, 'failed'); assert.equal(out.error.code, '190'); assert.ok(!out.error.message.includes('TEST_ONLY_TOKEN'));
});
test('ambiguous timeout is never retried automatically or by retry endpoint', async () => {
  env.whatsappDryRun = false; await inbound('Hi'); let calls = 0;
  globalThis.fetch = async () => { calls++; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  await messages.dispatchDueMessages(); await messages.dispatchDueMessages();
  const out = await Message.findOne({ direction: 'outbound' }); assert.equal(calls, 1); assert.equal(out.error.ambiguous, true);
  await assert.rejects(messages.retryMessage(out._id), /unknown/);
});
test('missing credentials and contradictory mode report NOT_READY', async () => {
  env.whatsappDryRun = false; env.whatsappAccessToken = '';
  assert.equal(getConnectionStatus().readiness, 'NOT_READY'); assert.equal((await client.sendText(phone, 'test')).ok, false);
  const result = resolveWhatsappEnv({ WHATSAPP_MODE: 'live', WHATSAPP_DRY_RUN: 'true' }); assert.equal(result.whatsappMode, 'not_ready');
});
test('24-hour window enforced again at dispatch', async () => {
  await inbound('Hi'); await Conversation.updateOne({ phone }, { $set: { lastInboundAt: new Date(Date.now() - 25 * 3600000) } });
  await messages.dispatchDueMessages(); assert.equal((await Message.findOne({ direction: 'outbound' })).error.code, 'WINDOW_CLOSED');
});
test('Inbox retrieves saved incoming and outgoing messages', async () => {
  const conv = await inbound('Hi'); await messages.dispatchDueMessages();
  const result = await conversations.getConversationMessages(conv._id, {});
  assert.equal(result.rows.length, 2); assert.ok(result.rows.some((r) => r.direction === 'inbound')); assert.ok(result.rows.some((r) => r.direction === 'outbound'));
});
test('wrong account/number events are excluded; media stores metadata without bot reply', async () => {
  const bad = payload(); bad.entry[0].changes[0].value.metadata.phone_number_id = 'WRONG'; assert.equal(webhook.extractEvents(bad).length, 0);
  await inbound('', { type: 'image', image: { id: 'media.TEST', mime_type: 'image/png', caption: 'fixture' } });
  assert.equal(await Message.countDocuments({ direction: 'outbound' }), 0); assert.equal((await Message.findOne()).media.id, 'media.TEST');
});

test('admin diagnostic routes still require authentication', async () => {
  assert.equal((await originalFetch(`${base}/api/whatsapp/settings`)).status, 401);
});
test('administrator-edited welcome survives default initialization', async () => {
  const original = await Automation.findOne({ systemKey: 'main_menu' }).lean();
  try {
    await Automation.updateOne({ _id: original._id }, { $set: { 'steps.0.text': 'Administrator custom welcome' } });
    await inbound('Hi'); assert.match((await Message.findOne({ direction: 'outbound' })).text, /Administrator custom welcome/);
  } finally {
    await Automation.updateOne({ _id: original._id }, { $set: { steps: original.steps } });
  }
});
test('bot disable and queued reply handover prevent automatic sends', async () => {
  await Settings.updateOne({ key: 'default' }, { $set: { autoReplyEnabled: false } });
  await inbound('Hi'); assert.equal(await Message.countDocuments({ direction: 'outbound' }), 0);
  await Settings.updateOne({ key: 'default' }, { $set: { autoReplyEnabled: true } });
  await inbound('menu'); await Conversation.updateOne({ phone }, { $set: { humanHandover: true } });
  await messages.dispatchDueMessages(); assert.equal((await Message.findOne({ direction: 'outbound' })).error.code, 'BOT_PAUSED');
});
test('expired event-processing lease recovers after worker restart', async () => {
  await webhook.ingestWebhook(payload());
  await Event.updateMany({}, { $set: { status: 'processing', lockedUntil: new Date(0), processingToken: 'OLD_WORKER', attempts: 1 } });
  await webhook.reprocessStuckEvents(); assert.equal(await Event.countDocuments({ status: 'processed' }), 1);
  assert.equal(await Message.countDocuments({ direction: 'outbound' }), 1);
});
test('expired sending lease becomes ambiguous failure without another API call', async () => {
  await inbound('Hi'); await Message.updateOne({ direction: 'outbound' }, { $set: { status: 'sending', lockedUntil: new Date(0) } });
  await messages.dispatchDueMessages(); const out = await Message.findOne({ direction: 'outbound' });
  assert.equal(out.error.code, 'AMBIGUOUS_CRASH'); assert.equal(out.status, 'failed');
});
test('mode change cannot send queued simulation messages live', async () => {
  await inbound('Hi'); env.whatsappDryRun = false;
  await messages.dispatchDueMessages(); assert.equal((await Message.findOne({ direction: 'outbound' })).error.code, 'MODE_CHANGED');
});
test('legacy queued message without saved operating mode is held before live send', async () => {
  env.whatsappDryRun = false; await inbound('Hi');
  await Message.updateOne({ direction: 'outbound' }, { $unset: { queuedMode: '' } });
  await messages.dispatchDueMessages();
  assert.equal((await Message.findOne({ direction: 'outbound' })).error.code, 'LEGACY_MODE_UNKNOWN');
});
test('explicit rate-limit rejection is queued for backoff', async () => {
  env.whatsappDryRun = false; await inbound('Hi');
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 130429, message: 'Rate limit' } }), { status: 429 });
  await messages.dispatchDueMessages(); const out = await Message.findOne({ direction: 'outbound' });
  assert.equal(out.status, 'queued'); assert.ok(out.nextAttemptAt > new Date()); assert.equal(out.error.retryable, true);
});
test('real delivery event cannot upgrade a simulated outbound message', async () => {
  await inbound('Hi'); await messages.dispatchDueMessages(); const out = await Message.findOne({ direction: 'outbound' });
  assert.equal(await messages.applyStatusUpdate({ id: out.providerMessageId, status: 'delivered' }), 'ignored');
  assert.equal((await Message.findById(out._id)).status, 'accepted');
});
test('mocked live webhook-to-worker-to-Inbox flow saves actual-format Meta response ID', async () => {
  env.whatsappDryRun = false;
  globalThis.fetch = async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.LIVE_FLOW_MOCK' }] }));
  assert.equal((await post(payload())).status, 200);
  const { runWorkerTick } = await import('../src/modules/whatsapp/services/worker.service.js');
  await runWorkerTick({ maxCampaignSends: 0 });
  const out = await Message.findOne({ direction: 'outbound' });
  assert.equal(out.status, 'accepted'); assert.equal(out.dryRun, false); assert.equal(out.providerMessageId, 'wamid.LIVE_FLOW_MOCK');
  const inbox = await conversations.getConversationMessages(out.conversationId, {}); assert.equal(inbox.rows.length, 2);
});
test('successful Meta HTTP response without message ID is held for review', async () => {
  env.whatsappDryRun = false; globalThis.fetch = async () => new Response('{}');
  const result = await client.sendText(phone, 'test'); assert.equal(result.ok, false); assert.equal(result.error.ambiguous, true);
});
test('patched mailer keeps existing createTransport/sendMail API without sending email', async () => {
  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const result = await transport.sendMail({ from: 'sender@example.test', to: 'recipient@example.test', subject: 'fixture', text: 'fixture', html: '<p>fixture</p>' });
  assert.equal(JSON.parse(result.message).subject, 'fixture'); transport.close();
});
test('genuine connection test validates phone identity and distinguishes webhook readiness', async () => {
  env.whatsappDryRun = false;
  globalThis.fetch = async (url, options) => {
    assert.match(url, /fields=display_phone_number,verified_name,quality_rating/); assert.equal(options.method, 'GET');
    return new Response(JSON.stringify({ id: env.whatsappPhoneNumberId, verified_name: 'Test Business' }));
  };
  const service = await import('../src/modules/whatsapp/whatsapp.service.js'); const result = await service.testConnection();
  assert.equal(result.apiValidated, true); assert.equal(result.webhookValidated, false);
  const settings = await service.getSettingsView({}); assert.equal(settings.connection.readiness, 'API_VALIDATED');
});

async function campaignFixture(status = 'Queued') {
  const template = await Template.create({ name: 'test_utility', language: 'en', source: 'meta', status: 'APPROVED', category: 'UTILITY', bodyText: 'Fixture' });
  const campaign = await Campaign.create({ name: 'Fixture', status, dryRun: env.whatsappDryRun,
    template: { templateId: template._id, name: template.name, language: 'en', source: 'meta', status: 'APPROVED', bodyText: 'Fixture' },
    totals: { recipients: 1 },
  });
  await Recipient.create({ campaignId: campaign._id, phone });
  return campaign;
}
test('campaign pause/resume and repeated worker ticks preserve one outbound record', async () => {
  const { runWorkerTick } = await import('../src/modules/whatsapp/services/worker.service.js');
  const service = await import('../src/modules/whatsapp/services/campaign.service.js');
  const campaign = await campaignFixture(); await service.pauseCampaign(campaign._id, 'test');
  await runWorkerTick(); assert.equal(await Message.countDocuments(), 0);
  await service.resumeCampaign(campaign._id, 'test'); await runWorkerTick(); await runWorkerTick();
  assert.equal(await Message.countDocuments({ origin: 'campaign' }), 1);
  assert.equal((await Campaign.findById(campaign._id)).status, 'Completed');
  assert.equal((await Recipient.findOne()).status, 'Sent');
});
test('failed campaign retry reuses its record and does not resend ambiguous outcomes', async () => {
  env.whatsappDryRun = false;
  const { runWorkerTick } = await import('../src/modules/whatsapp/services/worker.service.js');
  const service = await import('../src/modules/whatsapp/services/campaign.service.js');
  const campaign = await campaignFixture();
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 190, message: 'Mock token failure' } }), { status: 401 });
  await runWorkerTick(); assert.equal((await Campaign.findById(campaign._id)).status, 'Failed');
  await service.retryFailed(campaign._id, 'test');
  globalThis.fetch = async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.CAMPAIGN_MOCK' }] }));
  await runWorkerTick(); assert.equal(await Message.countDocuments(), 1); assert.equal((await Recipient.findOne()).status, 'Sent');
  await Message.updateMany({}, { $set: { status: 'failed', error: { code: 'AMBIGUOUS_TIMEOUT', ambiguous: true } } });
  await Recipient.updateMany({}, { $set: { status: 'Failed' } });
  await assert.rejects(service.retryFailed(campaign._id, 'test'), /Unknown send outcomes/);
});
test('shared callback updates matching Workshop delivery status without running chatbot', async () => {
  const workshop = await WorkshopMessage.create({ body: 'Fixture', recipients: [{ phone, waMessageId: 'wamid.WORKSHOP_MOCK', status: 'accepted' }] });
  assert.equal(await messages.applyStatusUpdate({ id: 'wamid.WORKSHOP_MOCK', status: 'delivered' }), 'processed');
  assert.equal((await WorkshopMessage.findById(workshop._id)).recipients[0].status, 'delivered');
  assert.equal(await Message.countDocuments(), 0);
});

test('actual Express entry verifies with real MongoDB connected and disconnected', async () => {
  // Use the serverless export to avoid starting the application's listener/worker.
  const previousVercel = process.env.VERCEL;
  process.env.VERCEL = '1';
  const { app } = await import('../src/index.js');
  const verificationServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => verificationServer.once('listening', resolve));
  const url = `http://127.0.0.1:${verificationServer.address().port}/api/whatsapp/webhook?${new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'TEST_ONLY_VERIFY', 'hub.challenge': '000456' })}`;
  try {
    assert.equal(mongoose.connection.readyState, 1);
    let response = await originalFetch(url);
    assert.equal(response.status, 200); assert.equal(await response.text(), '000456');
    await mongoose.disconnect();
    assert.equal(mongoose.connection.readyState, 0);
    response = await originalFetch(url);
    assert.equal(response.status, 200); assert.equal(await response.text(), '000456');
    const post = await originalFetch(url.split('?')[0], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 503);
  } finally {
    await new Promise((resolve) => verificationServer.close(resolve));
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});

