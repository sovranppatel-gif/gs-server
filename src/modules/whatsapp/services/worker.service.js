import mongoose from "mongoose";
import { safeError } from "../whatsapp.security.js";
import { WhatsAppCampaign } from "../models/whatsappCampaign.model.js";
import { WhatsAppCampaignRecipient } from "../models/whatsappCampaignRecipient.model.js";
import { WhatsAppContact } from "../models/whatsappContact.model.js";
import { WhatsAppMessage } from "../models/whatsappMessage.model.js";
import { WA_CONFIG } from "../whatsapp.config.js";
import { WhatsAppSettings } from "../models/whatsappSettings.model.js";
import { getSettings } from "./settings.service.js";
import { createOutbound, dispatchDueMessages, syncRecipient } from "./message.service.js";
import { reprocessStuckEvents } from "./webhook.service.js";
import { notifyAdmin } from "../whatsapp.utils.js";

/**
 * Durable MongoDB-backed queue. All state (campaign status, recipients,
 * outbox messages, schedule times) lives in Mongo, and every step claims work
 * with an atomic compare-and-set, so:
 *   - a restart loses nothing (work resumes on the next tick),
 *   - several server instances / cron ticks can run concurrently safely.
 * The interval below only *polls* that durable state; it is not the scheduler
 * of record (a missed tick is caught up by the next one).
 */

async function promoteCampaigns(now) {
  const scheduled = await WhatsAppCampaign.updateMany({ status: "Scheduled", scheduledAt: { $lte: now } }, { $set: { status: "Queued" } });
  const first = await WhatsAppCampaign.updateMany({ status: "Queued", startedAt: null }, { $set: { status: "Running", startedAt: now } });
  const resumed = await WhatsAppCampaign.updateMany({ status: "Queued" }, { $set: { status: "Running" } });
  if (scheduled.modifiedCount || first.modifiedCount || resumed.modifiedCount) notifyAdmin("campaign");
}

/** Turns pending recipients of running campaigns into outbox messages, within the rate budget. */
async function enqueueRecipients(budget, now) {
  if (budget <= 0) return 0;
  const running = await WhatsAppCampaign.find({ status: "Running" }).sort({ startedAt: 1 }).select("_id template dryRun").lean();
  let enqueued = 0;
  for (const campaign of running) {
    while (enqueued < budget) {
      const recipient = await WhatsAppCampaignRecipient.findOneAndUpdate(
        { campaignId: campaign._id, status: "Pending", messageId: null, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
        { $set: { lockedUntil: new Date(now.getTime() + WA_CONFIG.workerLeaseMs) } },
        { returnDocument: "after", sort: { _id: 1 } }
      );
      if (!recipient) break;

      const contact = await WhatsAppContact.findOne({ normalizedPhone: recipient.phone }).select("_id optOut").lean();
      if (contact?.optOut) {
        await WhatsAppCampaignRecipient.updateOne({ _id: recipient._id }, { $set: { status: "Skipped", skipReason: "Opted out", lockedUntil: null } });
        continue;
      }
      const existingMessage = await WhatsAppMessage.findOne({ idempotencyKey: `campaign:${recipient._id}` });
      const message = existingMessage || await createOutbound({
        contactId: contact?._id || null,
        phone: recipient.phone,
        template: { name: campaign.template.name, language: campaign.template.language, params: recipient.params, bodyText: campaign.template.bodyText },
        origin: "campaign",
        campaignId: campaign._id,
        campaignRecipientId: recipient._id,
        touch: false,
        dryRun: campaign.dryRun,
        idempotencyKey: `campaign:${recipient._id}`,
      });
      await WhatsAppCampaignRecipient.updateOne({ _id: recipient._id }, { $set: { messageId: message._id, lockedUntil: null } });
      if (existingMessage) await syncRecipient(existingMessage);
      enqueued += 1;
    }
    if (enqueued >= budget) break;
  }
  return enqueued;
}

async function finalizeCampaigns() {
  // Recovery if the process stopped between acceptance and recipient bookkeeping.
  const unfinished = await WhatsAppCampaignRecipient.find({ status: 'Pending', messageId: { $ne: null } }).limit(100).lean();
  for (const recipient of unfinished) {
    const message = await WhatsAppMessage.findById(recipient.messageId);
    if (message) await syncRecipient(message);
  }
  const running = await WhatsAppCampaign.find({ status: "Running" }).select("_id").lean();
  for (const c of running) {
    const pending = await WhatsAppCampaignRecipient.countDocuments({ campaignId: c._id, status: "Pending" });
    if (pending > 0) continue;
    const [total, failed] = await Promise.all([
      WhatsAppCampaignRecipient.countDocuments({ campaignId: c._id, status: { $ne: "Skipped" } }),
      WhatsAppCampaignRecipient.countDocuments({ campaignId: c._id, status: "Failed" }),
    ]);
    const status = total > 0 && failed === total ? "Failed" : "Completed";
    const res = await WhatsAppCampaign.updateOne(
      { _id: c._id, status: "Running" },
      { $set: { status, completedAt: new Date(), lastError: status === "Failed" ? "All recipients failed" : "" } }
    );
    if (res.modifiedCount) notifyAdmin("campaign", { campaignId: String(c._id) });
  }
}

/**
 * One pass over all queued work. `maxCampaignSends` caps campaign messages
 * for this tick (the per-minute rate is enforced against Mongo either way).
 */
async function tick({ maxCampaignSends = null, deadline = Date.now() + 20000 } = {}) {
  workerState.lastTickAt = new Date();
  if (mongoose.connection.readyState !== 1) return { skipped: "db_not_ready" };
  const now = new Date();
  const settings = await getSettings();
  const rate = settings.campaignRatePerMinute || 60;

  const reprocessed = await reprocessStuckEvents({ deadline });
  await promoteCampaigns(now);

  // Conversational messages (agent / automation retries) are never rate-held behind campaigns
  const conversational = await dispatchDueMessages({ limit: 50, origins: ["agent", "automation", "system"], deadline });

  const sentLastMinute = await WhatsAppMessage.countDocuments({ origin: "campaign", acceptedAt: { $gte: new Date(now.getTime() - 60_000) } });
  const perTick = maxCampaignSends ?? Math.max(1, Math.ceil((rate * WA_CONFIG.workerPollMs) / 60_000));
  const budget = Math.max(0, Math.min(perTick, rate - sentLastMinute));

  const runningIds = (await WhatsAppCampaign.find({ status: "Running" }).select("_id").lean()).map((c) => c._id);
  const queuedCampaign = runningIds.length
    ? await WhatsAppMessage.countDocuments({ origin: "campaign", status: "queued", campaignId: { $in: runningIds } })
    : 0;
  const enqueued = await enqueueRecipients(Math.max(0, budget - queuedCampaign), now);
  const campaignSent = runningIds.length
    ? await dispatchDueMessages({ limit: budget, origins: ["campaign"], deadline, extraFilter: { campaignId: { $in: runningIds } } })
    : 0;

  await finalizeCampaigns();
  workerState.lastCompletedAt = new Date();
  workerState.lastError = '';
  return { reprocessed, conversational, enqueued, campaignSent, budget };
}

export async function runWorkerTick(options = {}) {
  if (mongoose.connection.readyState !== 1) return { skipped: 'db_not_ready' };
  await getSettings();
  const leaseToken = new mongoose.Types.ObjectId().toString();
  const trigger = ['cron', 'admin', 'interval', 'simulation'].includes(options.trigger) ? options.trigger : 'unknown';
  const claim = await WhatsAppSettings.findOneAndUpdate({ key: 'default', $or: [{ workerLockedUntil: null }, { workerLockedUntil: { $lt: new Date() } }] }, {
    $set: { workerLeaseToken: leaseToken, workerLockedUntil: new Date(Date.now() + 120000), workerLastTickAt: new Date(), workerLastTrigger: trigger,
      ...(trigger === 'cron' ? { workerLastCronTickAt: new Date() } : {}),
    },
  }, { returnDocument: 'after' });
  if (!claim) return { skipped: 'worker_busy' };
  try {
    const result = await tick(options);
    await WhatsAppSettings.updateOne({ key: 'default' }, { $set: { workerLastCompletedAt: new Date(), workerLastError: '',
      ...(trigger === 'cron' ? { workerLastCronCompletedAt: new Date() } : {}),
    } });
    return result;
  } catch (error) {
    await WhatsAppSettings.updateOne({ key: 'default' }, { $set: { workerLastError: safeError(error) } }).catch(() => {});
    throw error;
  } finally {
    await WhatsAppSettings.updateOne({ key: 'default', workerLeaseToken: leaseToken }, { $set: { workerLockedUntil: null, workerLeaseToken: '' } }).catch(() => {});
  }
}

const workerState = { lastTickAt: null, lastCompletedAt: null, lastError: '' };
export const getWorkerState = () => ({ ...workerState, running: Boolean(timer), busy });
let timer = null;
let busy = false;

/** Long-running servers only. Serverless deployments use POST /api/whatsapp/cron/tick. */
export function startWhatsappWorker() {
  if (timer || process.env.VERCEL) return;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await runWorkerTick({ trigger: 'interval' });
    } catch (err) {
      workerState.lastError = safeError(err);
      console.error("[whatsapp] worker tick failed:", workerState.lastError);
    } finally {
      busy = false;
    }
  }, WA_CONFIG.workerPollMs);
  timer.unref?.();
  console.log("[whatsapp] queue worker started");
}

export async function stopWhatsappWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  const deadline = Date.now() + 25000;
  while (busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
}
