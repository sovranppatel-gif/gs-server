# GrowSkills Tech WhatsApp production setup

This upgrades the existing General WhatsApp CRM; it does not introduce another chatbot.
Code tests do not establish live delivery. Production acceptance requires a valid Meta
account, public HTTPS callback, WABA subscription, working worker and a real inbound test.

## Implementation and architecture

Public GET/POST: `/api/whatsapp/webhook`. The router is mounted once at `/api/whatsapp`.
GET verification does not require JWT or MongoDB. All admin diagnostics require the
existing Master Admin JWT and WhatsApp permissions. POST requires a valid raw-body
`X-Hub-Signature-256` HMAC in development and production, with a 2 MB request limit.

Flow:

1. Validate signature, account, phone identity and message field.
2. Insert durable unique webhook events in MongoDB; acknowledge 200 only after insertion.
   An insert failure returns 500 so Meta can retry. Duplicate event inserts are harmless.
3. A server worker or authenticated cron claims events with leases, in receive order per
   sender. Retries use backoff; exhausted/failed events remain visible and block later
   messages from that sender until an admin repairs/requeues them.
4. A MongoDB transaction saves incoming message, conversation changes, database-driven
   automation state, lead actions, outgoing records and event completion together.
   Failed processing rolls back the incoming insert too, so recovery does not skip the bot.
5. After commit, the worker dispatches the durable outbox through official Meta `/messages`.
6. Provider acceptance saves the returned `wamid`; status events update sent/delivered/read.
7. Post-commit Socket.IO hints update Inbox; its HTTP polling also works without sockets.

The admin browser is not part of this processing chain. Existing Contacts, Templates,
Campaigns, scheduling, reports, staff assignment and lead services remain in use.
Per-backend configuration targets one WABA/phone; this is not a multi-account tenant router.

Critical files: `src/index.js`, `src/config/{env,whatsappEnv}.js`,
`src/modules/whatsapp/whatsapp.{routes,controller,client,config,service}.js`,
`services/{webhook,execution,automation,message,worker,initialize}.service.js`,
and the existing WhatsApp models. Frontend Settings reports diagnostics through the
existing `whatsappService.js`; Inbox/automations still use the existing API.

## Database prerequisite and recovery

Use MongoDB Atlas or a MongoDB replica set. A standalone MongoDB cannot commit these
chatbot transactions; it is intentionally not allowed to process partially saved flows.
Mongoose transaction async-local sessions propagate into existing lead/contact services.
The initializer only creates additive indexes; it never drops indexes, data or collections.
If a new unique index fails due to old inconsistent data, inspect and repair records manually;
do not run destructive cleanup. Keep database backups and normal access restrictions.

Webhook events use unique `eventId`; incoming/outgoing messages use unique nonempty
provider IDs and outgoing action keys. Contacts have unique normalized phone numbers,
and conversations have unique contact IDs. Existing indexes and data are retained.

Outbox messages are marked `sending` before HTTP. If a process dies while sending, an
expired lease becomes `AMBIGUOUS_CRASH`, not another automatic send. A timeout or network
failure after POST is also ambiguous and is never automatically retried. Meta does not
provide this application with an exactly-once distributed transaction; acceptance before
a crash can be unknown. Confirm provider/customer state before an intentional new message.
Explicit transient API rejection can retry with backoff, up to `WHATSAPP_MAX_RETRIES`.
Queued messages retain their original live/dry-run mode. A mode change cannot accidentally
send old simulation messages live. Approved templates and 24-hour eligibility are checked
again at dispatch, as are opt-out, bot pause and marketing opt-in.

Older queued messages did not reliably store their original mode. They are held as
`LEGACY_MODE_UNKNOWN` before any API call. An authenticated manual retry after review marks
the intended mode; campaigns use their saved campaign mode. Do not retry legacy records
without checking whether they were test messages. Historical simulation IDs are also
excluded from live incoming-message diagnostics.

Settings → webhook events → Retry event requeues a failed job via authenticated
`POST /api/whatsapp/webhook-events/:id/retry`. Process queue now is also authenticated.
Legacy events with previously committed incoming messages are skipped to prevent duplicate
replies; an admin should review those conversations instead of blindly replaying them.

## Environment checklist

Local `.env` is ignored by Git; `.env.example` contains no real credentials. Do not commit
local environment files. Existing nonempty credentials are preserved. Local NODE_ENV stays
development; set production only in the real deployed environment. Local mode was explicitly
set to live/false for this task, so incomplete configuration reports NOT_READY.

| Key | Required / purpose |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | Fill manually: permanent System User token with appropriate assets/permissions |
| `WHATSAPP_PHONE_NUMBER_ID` | Fill manually: production Phone Number ID, not the visible telephone number |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Confirm existing value belongs to the same WABA/phone/app |
| `WHATSAPP_APP_ID` | Fill manually for Meta Dashboard/account management; not needed for basic sends |
| `WHATSAPP_APP_SECRET` | Fill manually: Meta App Secret for HMAC; never the webhook verify token |
| `WHATSAPP_VERIFY_TOKEN` | Fill manually: strong random shared verification string configured in Meta |
| `META_GRAPH_API_VERSION` | Canonical default `v26.0`; legacy `WHATSAPP_API_VERSION` is accepted |
| `WHATSAPP_WEBHOOK_URL` | Fill manually: exact deployed HTTPS backend URL ending `/api/whatsapp/webhook` |
| `WHATSAPP_MODE` | `live` or `dry_run` |
| `WHATSAPP_DRY_RUN` | `false` with live; `true` with dry_run; contradictory values fail closed |
| `WHATSAPP_AUTO_REPLY_ENABLED` | Environment kill switch; saved admin settings take precedence when false |
| `WHATSAPP_BUSINESS_TIMEZONE` | Default for new settings: `Asia/Kolkata`; saved business hours remain authoritative |
| `WHATSAPP_SEND_TIMEOUT_MS` | Default 15000; bounded HTTP timeout |
| `WHATSAPP_MAX_RETRIES` | Default 3 additional attempts, only for explicit retryable rejection |
| `WHATSAPP_TEST_RECIPIENT` | Fill manually: an explicitly authorized test number with country code |
| `CRON_SECRET` | Fill manually for serverless/external cron authorization; persistent worker does not need it |
| `MONGO_URI` | Atlas/replica-set URI with least-privilege database access |
| `NODE_ENV` | `production` only on production deployment |
| `JWT_SECRET`, SMTP settings | Existing application production requirements still apply |

Legacy `WHATSAPP_WEBHOOK_VERIFY_TOKEN` is accepted when canonical verify token is absent.
Canonical nonempty names take precedence. Do not set aliases to conflicting values.

The default Graph version was checked against Meta's current official SDK source on
2026-10-13, which uses v26.0: [Meta SDK source](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/api.js).
Meta's direct documentation returned HTTP 429 in this environment; consult the
[official version table](https://developers.facebook.com/docs/graph-api/changelog/versions/)
before later upgrades. This check confirms the version published by Meta, not credentials.

## Exact callback URL

The exact production hostname is not configured in this workspace. Do not assume the
frontend `www.growskillstech.com` is the backend. Configure
`WHATSAPP_WEBHOOK_URL=https://<actual-backend-host>/api/whatsapp/webhook`.
If the website reverse-proxies `/api` to this backend, the corresponding URL would be
`https://www.growskillstech.com/api/whatsapp/webhook`; this is conditional, not verified.
Use Settings → Callback URL after deployment. Do not append `/api` twice.

## Meta Dashboard setup

1. Select the business-owned Meta app with WhatsApp product/use case. Confirm real production
   number registration and business verification requirements for your account.
2. In Business Settings → System Users, use a System User with access to the app and WABA.
   Generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`.
   Where available select non-expiring/permanent lifetime; asset removal/revocation can still
   invalidate a token. Do not use the short-lived API Setup testing token in production.
3. Deploy code and fill server secrets in the host environment. Configure the same Phone
   Number ID, WABA ID and App Secret. Restart/update environment on the host.
4. Configure WhatsApp webhook callback URL and the exact verify token. Meta GET with
   `hub.mode=subscribe`, matching `hub.verify_token`, and `hub.challenge` returns exact text.
5. Subscribe to the WhatsApp business-account `messages` webhook field.
6. Ensure the app is subscribed to the actual WABA, not only the Meta test number. The
   official management operation is `POST /{WABA-ID}/subscribed_apps` with an authorized
   token. Verify using the corresponding GET. Perform it from a secure terminal or
   Meta's tools; never paste a token into chat or logs. The application does not make this
   account-changing subscription automatically.
7. Set app Live mode and complete applicable permissions/access review for the deployment.
8. Sync approved templates from the existing Templates page when business-initiated sends
   are needed. Marketing messages require applicable explicit opt-in.

References: [Meta Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/),
[Meta webhook reference](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/),
[Meta-owned API collection](https://www.postman.com/meta/whatsapp-business-platform/overview).

## Persistent VPS / PM2

Use the prepared `deploy/ecosystem.config.cjs` only if there is no existing PM2 app config
on the host; integrate settings into the existing process if one exists. Commands from
the deployed `gs-server` directory (no secrets on command line):

```sh
npm ci --omit=dev
pm2 start deploy/ecosystem.config.cjs --env production
pm2 save
# Subsequent releases:
npm ci --omit=dev
pm2 restart growskills-api --update-env
curl -fsS https://<actual-backend-host>/api/health
```

PM2 startup/service registration is host-specific. Set Node >=20.19 (Node 24 LTS preferred).
No admin browser needs to remain open. SIGTERM stops new interval ticks and gives active
work time to finish before disconnecting Mongo. Durable jobs remain available on restart.
Do not expose port 3000 publicly. Integrate `deploy/whatsapp-nginx.conf.example` into the
existing HTTPS proxy, using the real domain and certificate paths. Preserve the full
`/api/whatsapp/webhook` path and raw body bytes. Avoid logging verification query tokens.

## Vercel / serverless

Existing `api/index.js` awaits Mongo connection and WhatsApp index/default initialization.
POST persists jobs before returning; no fire-and-forget post-response work is required.
`vercel.json` sets a 60-second function budget and a one-minute cron for
`/api/whatsapp/cron/tick`. Cron authenticates via `Authorization: Bearer CRON_SECRET`.
Your Vercel plan must support this schedule and duration. A once-daily Hobby cron is not
adequate for a production chatbot. Expect up to a minute of queue delay, plus backoff.
For immediate conversational responses prefer a persistent worker/VPS. If using another
external scheduler, call the authenticated cron endpoint without exposing its secret.
No persistent setInterval is started on Vercel. Cron leases prevent overlapping queue ticks.

## Tests and live acceptance

```sh
npm ci --ignore-scripts
npm run test:whatsapp
# From gs-frontend:
npm run build
```

Tests use Node's test runner, a disposable Mongo replica set, and mocked Meta HTTP calls.
They never connect to the configured customer database or send WhatsApp messages.
On Windows an installed MongoDB 8.0 binary is used when available; alternatively set
`MONGOMS_SYSTEM_BINARY` to your test mongod path. Otherwise the test dependency downloads
a MongoDB binary (internet access required). Never point tests at your production database.

Live checklist (not completed in this workspace):

- Settings shows live/unverified, then Test Connection validates the actual phone object.
  Connection validation proves API access only, not webhook subscription or delivery.
- Use only the explicitly authorized `WHATSAPP_TEST_RECIPIENT` for real tests.
- Send Hi from that number to the business number. Observe a real, nonsimulated webhook,
  saved inbound, welcome/menu reply, stored provider ID, and delivered/read confirmation.
- Reply 2 → select course → give name → callback time. Check one lead and persisted state.
- Reply menu then 6; check Pending/human handover and absence of automatic interruption.
- Disable and resume bot from Inbox; confirm both settings and pending outbox honour pause.
- Redeliver the same signed event: one inbound and one reply. Restart between acceptance
  and processing: worker recovers; restart mid-send: unknown outcomes are held for review.
- With the browser closed, repeat Hi and confirm delivery from customer/provider records.

Default automations are inserted only once. Administrator-edited/deleted flows are not
overwritten. New installations receive the requested GrowSkills welcome text and six options;
existing installations keep their saved welcome/menu unless an admin edits it.

## Diagnostics and troubleshooting

Settings shows effective mode, missing keys, API validation, callback URL, signature setup,
last real webhook, last inbound, last real auto-reply acceptance/failure, bot state, worker
heartbeat, pending/failed jobs and redacted errors. Dry-run statuses remain labeled simulated.

| Symptom | Check |
| --- | --- |
| Verification 403 | Exact verify token, hub.mode, correct backend URL |
| POST 401 | Meta App Secret, signature header, original request bytes |
| POST 503 | Missing app secret or unavailable DB |
| No incoming events | WABA subscribed_apps, messages field, phone identity, HTTPS/proxy |
| Received but no reply | Worker/cron heartbeat, event failures, replica set, bot setting, handover, opt-out |
| NOT_READY | Missing/contradictory environment values; credentials do not imply API validation |
| Error 190 | Invalid/expired/revoked token or incorrect app/asset permissions |
| 131026 | Recipient not reachable/eligible; inspect authenticated error details |
| 131047 / WINDOW_CLOSED | Service window closed; use an approved eligible template |
| 130429 / 131056 | Rate limiting; reduce rate, allow backoff, check account limits |
| AMBIGUOUS_* | Check provider/customer before an intentional new send; do not auto-retry |
| Duplicate-index startup error | Audit old records; never reset/drop the database |
| Accepted but not Delivered | Acceptance is not delivery; inspect signed status webhooks |

## Safe rollback

Turn `WHATSAPP_AUTO_REPLY_ENABLED=false` off first. Pause campaigns and keep durable jobs
and customer data. Roll back source/lockfile to your previous release, keep secrets intact,
and restart using the existing deployment process. New schema fields/indexes are additive;
do not delete them or clear collections. Review pending/sending/ambiguous records before
reenabling a sender, especially if rolling back to an older implementation that retries
timeouts. Reverting to unsafe sending code is not a safe way to recover unknown outcomes.

## Current validation boundaries

Local validation on 2026-10-13: 42/42 production tests passed against an isolated MongoDB
8.0 replica set with mocked Meta requests; frontend production build passed (existing
large-bundle warning); backend import and syntax checks passed; updated dependency audit
reported zero vulnerabilities. Campaign controls and Workshop delivery-status forwarding
are covered. No customer database was used for tests and no real email/WhatsApp message was sent.

No real
Meta API send, live inbound webhook, production restart or deployment was performed:
essential local credentials and exact backend URL are missing, and no authenticated
deployment project is available. Complete the live checklist before treating this as a
verified production integration.
