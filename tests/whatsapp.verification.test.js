import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// No developer secrets, customer database, credentials or external requests.
Object.assign(process.env, {
  VERCEL: '1', NODE_ENV: 'development',
  MONGO_URI: 'mongodb://127.0.0.1:1/TEST_ONLY_NEVER_CONNECT',
  JWT_SECRET: 'TEST_ONLY_JWT_SECRET_MORE_THAN_32_CHARACTERS',
  WHATSAPP_VERIFY_TOKEN: 'VERIFICATION_TEST_TOKEN',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: '', WHATSAPP_APP_SECRET: 'TEST_ONLY_APP_SECRET',
  WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_MODE: 'dry_run', WHATSAPP_DRY_RUN: 'true',
});
const mongoose = (await import('mongoose')).default;
const { env } = await import('../src/config/env.js');
const { requireDbReady, isWhatsappWebhookVerificationRequest } = await import('../src/middleware/requireDbReady.js');
const { app } = await import('../src/index.js');
const vercelHandler = (await import('../api/index.js')).default;
const router = (await import('../src/modules/whatsapp/whatsapp.routes.js')).default;
const originalStateDescriptor = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
let readyState = 0;
let servers = [], urls = {};
const verificationPath = '/api/whatsapp/webhook';
const expectedDbMessage = 'Server is connecting to the database. Please wait a few seconds and try again.';
function query({ token = 'VERIFICATION_TEST_TOKEN', mode = 'subscribe', challenge = '000123', path = verificationPath } = {}) {
  return `${path}?${new URLSearchParams({ 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge })}`;
}
async function request(entry, options = {}, fetchOptions) {
  return fetch(urls[entry] + query(options), fetchOptions);
}

before(async () => {
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => readyState });
  // Exercise the readiness middleware before the router, exactly as deployed APIs do.
  const gated = express();
  gated.use('/api', requireDbReady);
  gated.use('/api/whatsapp', router);
  const adapter = express(); adapter.use(vercelHandler);
  for (const [name, application] of Object.entries({ app, gated, adapter })) {
    const server = application.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    servers.push(server); urls[name] = `http://127.0.0.1:${server.address().port}`;
  }
});
beforeEach(() => {
  readyState = 0; env.whatsappVerifyToken = 'VERIFICATION_TEST_TOKEN';
  mock.restoreAll();
  // Any attempted Mongo connection is a test failure, not a request to a real database.
  mock.method(mongoose, 'connect', async () => { throw new Error('Unexpected database connection during verification'); });
});
after(async () => {
  mock.restoreAll();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  if (originalStateDescriptor) Object.defineProperty(mongoose.connection, 'readyState', originalStateDescriptor);
  else delete mongoose.connection.readyState;
});

for (const state of [0, 1, 2, 3]) {
  for (const entry of ['app', 'gated', 'adapter']) {
    test(`${entry}: GET challenge works with Mongo readyState=${state} without a database call`, async () => {
      readyState = state;
      const response = await request(entry);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '000123');
      assert.match(response.headers.get('content-type'), /^text\/plain/);
      assert.equal(response.headers.get('retry-after'), null);
      assert.equal(mongoose.connect.mock.callCount(), 0);
    });
  }
}
for (const entry of ['app', 'gated', 'adapter']) {
  test(`${entry}: wrong token is 403 instead of 503 while Mongo disconnected`, async () => {
    assert.equal((await request(entry, { token: 'WRONG' })).status, 403);
  });
  test(`${entry}: missing configured token fails closed without Mongo`, async () => {
    env.whatsappVerifyToken = '';
    assert.equal((await request(entry)).status, 403);
  });
  test(`${entry}: invalid hub.mode is rejected`, async () => {
    assert.equal((await request(entry, { mode: 'invalid' })).status, 403);
  });
  test(`${entry}: challenge preserves Unicode, spaces, plus signs and leading zeros`, async () => {
    const challenge = '0000 + exact & challenge \u2713';
    const response = await request(entry, { challenge });
    assert.equal(response.status, 200); assert.equal(await response.text(), challenge);
  });
  test(`${entry}: trailing slash still verifies without Mongo`, async () => {
    assert.equal((await request(entry, { path: `${verificationPath}/` })).status, 200);
  });
}
for (const path of ['/api/whatsapp/settings', '/api/whatsapp/webhook/extra', '/api/whatsapp/cron/tick', '/api/staff']) {
  test(`database guard preserved for GET ${path}`, async () => {
    const response = await fetch(urls.app + path);
    assert.equal(response.status, 503); assert.equal((await response.json()).message, expectedDbMessage);
    assert.equal(response.headers.get('retry-after'), '3');
  });
}
test('POST webhook remains database-gated while disconnected', async () => {
  const response = await fetch(urls.app + verificationPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 503); assert.equal((await response.json()).message, expectedDbMessage);
});
test('POST webhook still checks HMAC while connected', async () => {
  readyState = 1;
  const response = await fetch(urls.app + verificationPath, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` }, body: '{}' });
  assert.equal(response.status, 401);
});
test('HEAD/PUT/DELETE verification requests do not bypass the database guard', async () => {
  for (const method of ['HEAD', 'PUT', 'DELETE']) {
    assert.equal((await request('app', {}, { method })).status, 503);
  }
});
test('connected admin API retains JWT requirement', async () => {
  readyState = 1;
  assert.equal((await fetch(urls.app + '/api/whatsapp/settings')).status, 401);
});
test('mounted middleware identifies the exact original path, not similar prefixes', () => {
  assert.equal(isWhatsappWebhookVerificationRequest({ method: 'GET', originalUrl: query(), url: '/whatsapp/webhook' }), true);
  assert.equal(isWhatsappWebhookVerificationRequest({ method: 'GET', originalUrl: '/api/whatsapp/webhook/extra' }), false);
  assert.equal(isWhatsappWebhookVerificationRequest({ method: 'POST', originalUrl: verificationPath }), false);
});
