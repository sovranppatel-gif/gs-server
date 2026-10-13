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
| `WHATSAPP_AUTO_REPLY_ENABLED` | Environment kill switch; this switch AND saved `autoReplyEnabled` must allow replies |
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

The backend deployment URL supplied by the owner is `https://gs-server-woad.vercel.app`.
The exact callback is `https://gs-server-woad.vercel.app/api/whatsapp/webhook`.
The local `WHATSAPP_WEBHOOK_URL` is set to this value. Set the same value in Vercel's
production environment and redeploy, then enter it in Meta webhook configuration.
Remote health/verification could not be confirmed from this environment; the supplied
hostname is not evidence of successful webhook delivery. Do not append `/api` twice.

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

## Diagnosing Bot: Disabled

`GET /api/whatsapp/settings` is authenticated with the existing Master Admin JWT and
WhatsApp view permission. It reads the singleton `whatsapp_settings` record and the
environment loaded by the deployed backend. The effective bot control is:

```text
saved autoReplyEnabled AND environment WHATSAPP_AUTO_REPLY_ENABLED
```

Enabled automation documents do not override either switch. The same controls are
checked before automation execution and again before dispatching an automatic reply.
Changing the checkbox without saving does not change the effective bot control.
For a new settings record the saved flag defaults to the environment switch. If that
record was created while the environment disabled replies, enabling the environment
later does not overwrite the saved false value. Save the intended setting explicitly.
Legacy records with a missing flag remain disabled until an administrator saves it.

Settings diagnostics now show both switches, an explicit disable reason, the enabled
automation count and worker status. An older response without bot diagnostics no longer
implicitly renders Disabled: known flags can be used, otherwise it shows Unavailable.
Bot enabled means its controls allow automation, not that Meta delivery is verified.
Worker status separately reports missing cron secret, no heartbeat, stale heartbeat,
last worker error, stopped interval or a recent tick. A recent tick can be manual and
does not prove the cron schedule or successful message delivery.

The public GET webhook handshake only checks `WHATSAPP_VERIFY_TOKEN`. Incoming POST
requires HMAC-SHA256 over original request bytes with `WHATSAPP_APP_SECRET` in every
environment, then durable MongoDB event acceptance. A missing secret rejects POST with
503; an invalid/missing signature returns 401. Successful GET verification does not
validate POST signatures, WABA subscription, chatbot execution or the sender token.

Deployment checklist for the backend Vercel project's **Production** environment:

- Set `WHATSAPP_AUTO_REPLY_ENABLED=true`, `WHATSAPP_MODE=live`, `WHATSAPP_DRY_RUN=false`.
- Preserve valid `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
  `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`
  and `META_GRAPH_API_VERSION`. App Secret must belong to the app sending the webhook;
  it is different from the verify token. Do not paste secret values into diagnostic logs.
- Set `WHATSAPP_WEBHOOK_URL=https://gs-server-woad.vercel.app/api/whatsapp/webhook`.
- Configure `CRON_SECRET` and verify `/api/whatsapp/cron/tick` executes every minute.
  Vercel Hobby allows only daily cron and rejects more frequent expressions; Pro and
  Enterprise allow every minute. If using an external scheduler instead, remove the
  incompatible Vercel cron declaration as part of that deployment's configuration.
- After an approved deployment, save Auto replies enabled in Settings; confirm both
  controls, intended automations, signature configuration and a recent worker tick.
- Check the frontend build's `VITE_API_BASE_URL` targets this backend host without a
  trailing `/api`, since the WhatsApp client adds `/api/whatsapp` itself.

Local `.env` does not update Vercel configuration; dotenv also preserves already-set
process environment values. Changes in Vercel variables apply only to new deployments.
Restart the local API after editing `.env`; `npm run dev` watches `src`, and does not
reload `.env` automatically. The Settings API row shows the actual browser request URL;
in Vite development this can use a same-origin proxy to the local API. A Vercel callback
URL in backend configuration does not make the admin API use the deployed backend.
Redeploy backend and frontend code only after approval. See
[Vercel environment variables](https://vercel.com/docs/environment-variables) and
[Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

## Production Settings response audit (2026-10-13)

The public production Settings endpoint returned HTTP 401/JSON without an admin session,
as required. The owner supplied the authenticated response. It has `success: true` and
saved `autoReplyEnabled: true`, but omits the entire `data.diagnostics` object and
`connection.autoReplyAllowed`, `connection.readiness` and `connection.webhookUrl`.
It also returns internal worker lease fields that the current local service filters out.
The public frontend bundle points to the correct `gs-server-woad.vercel.app` host and
contains the newer Settings UI. These facts confirm an older backend response contract;
they do not demonstrate that the environment bot switch is enabled or disabled.

The supplied response reports no recorded real webhook event. Saved worker timestamps
are present, but do not identify whether work came from cron or a manual tick. Neither
configured credentials nor a successful Settings HTTP response verifies Meta delivery,
Coexistence onboarding, a deployed Vercel plan or functioning scheduled work.

The current response preserves `{ success: true, data: { connection, webhook, settings,
permissions, diagnostics } }` and adds `diagnostics.schemaVersion: 2`, non-secret
configuration booleans, deployment revision, real event processing/counts, signature
evidence, cron execution evidence and Coexistence limitations. The Settings controller
returns `Cache-Control: no-store` and `X-WhatsApp-Diagnostics-Version: 2`.
Settings GET is read-only, including skipping default seeding in the Vercel adapter.
Missing saved settings are reported as unknown, rather than inserted during diagnostics.

The frontend validates the core payload even on HTTP 200. Missing/malformed diagnostics
produce specific field names and a deployment warning. Missing counts remain unavailable;
legacy worker timestamps are shown as limited evidence. Unknown environment flags cannot
become Enabled. Contradictory bot flags cannot become a verified bot status.
No new endpoint, public admin bypass or hardcoded replacement automation was introduced.

Signature evidence is written only after successful HTTP HMAC validation; simulation
never counts. Older event records are not backfilled with invented verification evidence.
Processing outcomes expose static reasons such as `human_handover` or
`auto_reply_disabled`, without customer message bodies. New cron timestamps distinguish
an authenticated queue tick from an admin/simulation run. The hosting plan remains
`not_verified` because the application cannot infer it from environment credentials.

## Business App / Cloud API Coexistence boundary

This integration accepts Cloud API `messages` events. The current parser does not import
Business App `smb_message_echoes`, `history` or `smb_app_state_sync` events; these events
must not trigger incoming-message automation. There is no Embedded Signup onboarding
record in this implementation. Diagnostics therefore report `not_verified` and
`cloud_api_messages_only`, even when send credentials are configured or API-validated.
The Business App's outbound conversation history and human responses are not synchronized
with CRM handover; use the CRM's existing handover controls while this limitation exists.

Confirm the number's actual Coexistence onboarding, app/WABA subscription and correct
`messages` callback in Meta Dashboard. Credentials alone do not establish onboarding.
See [Meta Business App onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)
and [Meta echo webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes).
Meta's primary documentation returned HTTP 429 during this audit, so current account
eligibility/onboarding requirements were not verified from this workspace. Do not
declare full Coexistence synchronization support or switch providers based on this audit.

## Deployment commands (manual approval required)

The backend has not been deployed by this task. First verify the Vercel plan supports
the existing every-minute cron (Pro/Enterprise), or arrange an authorized external
scheduler and its deployment configuration. Preserve server secrets in Vercel's
Production environment; local `.env` is not uploaded. Then, from PowerShell:

```powershell
Set-Location D:\growskillstech\gs-server
npm.cmd ci
npm.cmd run test:whatsapp
npx.cmd vercel link
# Select the EXISTING backend project. After approval:
npx.cmd vercel --prod

Set-Location D:\growskillstech\gs-frontend
npm.cmd ci
node --test tests/whatsapp.diagnostics.test.js
$env:VITE_API_BASE_URL = 'https://gs-server-woad.vercel.app'
npm.cmd run build
```

Publish the frontend `dist` contents using the site's existing hosting process only
after approval. No hosting account/SSH destination was supplied, so do not invent an
upload target. Use the existing admin session to read Settings after deployment:
verify `data.diagnostics.schemaVersion === 2`, both bot control booleans, numeric
automation count, configuration flags and worker/cron evidence. If schema 2 is absent,
check the linked backend project, root directory, production alias and deployed revision.
Changes to Vercel environment values require a new deployment. Never test by clicking
Process queue now or retrying events without approval: those actions can send messages.

Files changed by this diagnostics fix:

- Backend: `api/index.js`, `src/config/whatsappEnv.js`,
  `src/modules/whatsapp/whatsapp.controller.js`, `whatsapp.service.js`,
  `whatsapp.diagnostics.js`, `models/whatsappSettings.model.js`,
  `models/whatsappWebhookEvent.model.js`, `services/settings.service.js`,
  `services/webhook.service.js`, `services/worker.service.js` (module-relative paths).
- Backend tests: `tests/whatsapp.diagnostics.test.js`, `tests/whatsapp.production.test.js`.
- Frontend: `src/services/whatsappService.js`,
  `src/components/master-admin/whatsapp/whatsappDiagnostics.js`,
  `src/components/master-admin/whatsapp/WhatsAppSettingsPage.jsx`,
  `tests/whatsapp.diagnostics.test.js`.
- Documentation: `WHATSAPP_PRODUCTION_SETUP.md`.

## Tests and live acceptance

```sh
npm ci --ignore-scripts
npm run test:whatsapp
# From gs-frontend:
node --test tests/whatsapp.diagnostics.test.js
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
| Bot disabled despite enabled automations | Saved auto-reply flag AND deployed environment switch; save checkbox changes; update older backend diagnostics |
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

Local validation on 2026-10-13: 101/101 backend tests (production flow, verification and
diagnostics) passed against an isolated MongoDB 8.0 replica set with mocked Meta requests;
13/13 frontend bot-status/response-contract tests passed; the frontend production build passed with its
existing large-bundle warning. Campaign controls, signature rejection, both bot
switches, legacy missing settings, queued-reply pause, serverless heartbeat and Workshop
delivery-status forwarding are covered. No customer database was used for tests and no
real email/WhatsApp message was sent.

Local configuration permits live auto replies and essential credential keys are set,
but presence does not validate their values. Read-only access to the configured database
was unavailable from this workspace (connection timeout/refusal); it did not establish
an authentication problem. The owner's authenticated production response confirms saved
auto replies are enabled and the deployed diagnostic contract is older. Its environment
switch, actual Vercel plan, Meta delivery and Coexistence onboarding remain unverified.
Public read-only HTTPS probes and the owner-supplied response were used for this audit;
no live Meta requests, message sends, deployment or production write operations were
performed. Complete the live checklist only
with explicit approval before treating this as a verified production integration.
