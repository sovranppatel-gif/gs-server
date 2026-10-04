import { WhatsAppCampaign, WA_CAMPAIGN_STATUSES } from "../models/whatsappCampaign.model.js";
import { WhatsAppCampaignRecipient, WA_RECIPIENT_STATUSES } from "../models/whatsappCampaignRecipient.model.js";
import { WhatsAppMessage } from "../models/whatsappMessage.model.js";
import { WhatsAppTemplate } from "../models/whatsappTemplate.model.js";
import { isDryRun } from "../whatsapp.config.js";
import { describeAudience, resolveAudience } from "./audience.service.js";
import { renderTemplateBody, templateSendability } from "./template.service.js";
import { assertObjectId, badRequest, cleanString, notFound, notifyAdmin, pageResult, parsePaging } from "../whatsapp.utils.js";

const VAR_SOURCES = ["name", "phone", "course", "batch", "static"];

function normalizeMapping(template, mapping = []) {
  return (template.variables || []).map((v) => {
    const m = (Array.isArray(mapping) ? mapping : []).find((x) => Number(x.index) === v.index) || {};
    const source = VAR_SOURCES.includes(m.source) ? m.source : v.index === 1 ? "name" : "static";
    const value = cleanString(m.value, 500);
    if (source === "static" && !value) throw badRequest(`Enter a value for {{${v.index}}} (${v.label})`);
    return { index: v.index, source, value };
  });
}

export function paramsFor(row, mapping) {
  return mapping.map((m) => {
    if (m.source === "static") return m.value;
    const v = m.source === "name" ? row.name : row[m.source];
    return cleanString(v, 500) || m.value || (m.source === "name" ? "there" : "-");
  });
}

async function loadTemplate(templateId) {
  const t = await WhatsAppTemplate.findById(assertObjectId(templateId, "template id")).lean();
  if (!t) throw notFound("Template not found");
  const sendability = templateSendability(t);
  if (!sendability.allowed) throw badRequest(sendability.note);
  return { template: t, sendability };
}

/** Recipient preview: counts after normalise/dedupe/opt-out + personalised samples. */
export async function previewCampaign(body = {}) {
  const audience = await resolveAudience(body.audience);
  let template = null;
  let sendability = null;
  let mapping = [];
  if (body.templateId) {
    ({ template, sendability } = await loadTemplate(body.templateId));
    mapping = normalizeMapping(template, body.variableMapping);
  }
  const sample = audience.rows.slice(0, 25).map((r) => ({
    ...r,
    preview: template ? renderTemplateBody(template.bodyText, paramsFor(r, mapping)) : "",
  }));
  return { stats: audience.stats, invalidSamples: audience.invalidSamples, sample, sendability, dryRun: isDryRun() };
}

export async function createCampaign(body = {}, by = "master-admin") {
  const name = cleanString(body.name, 120);
  if (!name) throw badRequest("Campaign name is required");
  if (!body.templateId) throw badRequest("Select a template");
  const { template } = await loadTemplate(body.templateId);
  const mapping = normalizeMapping(template, body.variableMapping);

  let scheduledAt = null;
  if (body.scheduledAt) {
    scheduledAt = new Date(body.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) throw badRequest("Invalid schedule time");
    if (scheduledAt.getTime() < Date.now() - 60_000) throw badRequest("Schedule time is in the past");
  }

  const audience = await resolveAudience(body.audience);
  if (!audience.rows.length) throw badRequest("No sendable recipients after removing invalid, duplicate and opted-out numbers");

  const campaign = await WhatsAppCampaign.create({
    name,
    description: cleanString(body.description, 500),
    kind: scheduledAt ? "scheduled" : "bulk",
    status: "Draft",
    audience: { source: body.audience.source, filters: body.audience.filters || {}, summary: describeAudience(body.audience) },
    template: {
      templateId: template._id,
      name: template.name,
      language: template.language,
      status: template.status,
      source: template.source,
      bodyText: template.bodyText,
      variableMapping: mapping,
    },
    scheduledAt,
    totals: {
      recipients: audience.rows.length,
      excludedDuplicates: audience.stats.duplicates,
      excludedOptOut: audience.stats.optedOut,
      excludedInvalid: audience.stats.invalid,
    },
    dryRun: isDryRun(),
    createdBy: by,
    updatedBy: by,
  });

  try {
    for (let i = 0; i < audience.rows.length; i += 1000) {
      const chunk = audience.rows.slice(i, i + 1000).map((r) => ({
        campaignId: campaign._id,
        phone: r.phone,
        name: r.name,
        course: r.course || "",
        batch: r.batch || "",
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        params: paramsFor(r, mapping),
      }));
      await WhatsAppCampaignRecipient.insertMany(chunk, { ordered: false });
    }
  } catch (err) {
    if (err?.code !== 11000 && !err?.writeErrors) {
      await WhatsAppCampaignRecipient.deleteMany({ campaignId: campaign._id });
      await campaign.deleteOne();
      throw err;
    }
  }

  // Draft only while recipients were being written; the worker takes it from here.
  campaign.status = scheduledAt && scheduledAt.getTime() > Date.now() ? "Scheduled" : "Queued";
  await campaign.save();
  notifyAdmin("campaign", { campaignId: String(campaign._id) });
  return getCampaign(campaign._id);
}

async function countsFor(ids) {
  const rows = await WhatsAppCampaignRecipient.aggregate([
    { $match: { campaignId: { $in: ids } } },
    { $group: { _id: { c: "$campaignId", s: "$status" }, n: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const r of rows) {
    const key = String(r._id.c);
    if (!map.has(key)) map.set(key, Object.fromEntries(WA_RECIPIENT_STATUSES.map((s) => [s, 0])));
    map.get(key)[r._id.s] = r.n;
  }
  return map;
}

function withCounts(c, counts) {
  const k = counts || Object.fromEntries(WA_RECIPIENT_STATUSES.map((s) => [s, 0]));
  const total = Object.values(k).reduce((a, b) => a + b, 0);
  const reached = k.Sent + k.Delivered + k.Read;
  return {
    ...c,
    counts: k,
    total,
    progress: total ? Math.round(((total - k.Pending) / total) * 100) : 0,
    deliveryRate: reached ? Math.round(((k.Delivered + k.Read) / reached) * 100) : 0,
    readRate: reached ? Math.round((k.Read / reached) * 100) : 0,
  };
}

export async function listCampaigns(query = {}) {
  const paging = parsePaging(query);
  const filter = {};
  if (query.kind === "bulk" || query.kind === "scheduled") filter.kind = query.kind;
  if (query.status && WA_CAMPAIGN_STATUSES.includes(query.status)) filter.status = query.status;
  const [rows, total] = await Promise.all([
    WhatsAppCampaign.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit).lean(),
    WhatsAppCampaign.countDocuments(filter),
  ]);
  const counts = await countsFor(rows.map((r) => r._id));
  return pageResult(rows.map((r) => withCounts(r, counts.get(String(r._id)))), total, paging);
}

export async function getCampaign(id) {
  const c = await WhatsAppCampaign.findById(assertObjectId(id, "campaign id")).lean();
  if (!c) throw notFound("Campaign not found");
  const counts = await countsFor([c._id]);
  return withCounts(c, counts.get(String(c._id)));
}

export async function listRecipients(id, query = {}) {
  const campaignId = assertObjectId(id, "campaign id");
  const paging = parsePaging(query, { defaultLimit: 50, maxLimit: 200 });
  const filter = { campaignId };
  if (query.status && WA_RECIPIENT_STATUSES.includes(query.status)) filter.status = query.status;
  if (query.search) filter.$or = [{ name: new RegExp(cleanString(query.search, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }, { phone: new RegExp(String(query.search).replace(/\D/g, "") || "^$") }];
  const [rows, total] = await Promise.all([
    WhatsAppCampaignRecipient.find(filter).select("-lockedUntil").sort({ _id: 1 }).skip(paging.skip).limit(paging.limit).lean(),
    WhatsAppCampaignRecipient.countDocuments(filter),
  ]);
  return pageResult(rows, total, paging);
}

async function transition(id, from, to, extra = {}) {
  const c = await WhatsAppCampaign.findOneAndUpdate(
    { _id: assertObjectId(id, "campaign id"), status: { $in: from } },
    { $set: { status: to, ...extra } },
    { returnDocument: "after" }
  ).lean();
  if (!c) {
    const exists = await WhatsAppCampaign.exists({ _id: id });
    if (!exists) throw notFound("Campaign not found");
    throw badRequest(`Campaign can't move to ${to} from its current status`);
  }
  notifyAdmin("campaign", { campaignId: String(c._id) });
  return c;
}

export async function pauseCampaign(id, by) {
  await transition(id, ["Scheduled", "Queued", "Running"], "Paused", { pausedAt: new Date(), updatedBy: by });
  return getCampaign(id);
}

export async function resumeCampaign(id, by) {
  const c = await WhatsAppCampaign.findById(assertObjectId(id, "campaign id")).select("scheduledAt startedAt").lean();
  if (!c) throw notFound("Campaign not found");
  const to = c.scheduledAt && !c.startedAt && c.scheduledAt.getTime() > Date.now() ? "Scheduled" : "Queued";
  await transition(id, ["Paused"], to, { pausedAt: null, updatedBy: by });
  return getCampaign(id);
}

export async function cancelCampaign(id, by) {
  const c = await transition(id, ["Draft", "Scheduled", "Queued", "Running", "Paused"], "Cancelled", { cancelledAt: new Date(), updatedBy: by });
  await WhatsAppCampaignRecipient.updateMany({ campaignId: c._id, status: "Pending" }, { $set: { status: "Skipped", skipReason: "Campaign cancelled" } });
  await WhatsAppMessage.updateMany(
    { campaignId: c._id, status: "queued" },
    { $set: { status: "failed", failedAt: new Date(), nextAttemptAt: null, error: { code: "CANCELLED", message: "Campaign cancelled", retryable: false } } }
  );
  return getCampaign(id);
}

/** Re-queues failed recipients (opted-out contacts stay excluded). */
export async function retryFailed(id, by) {
  const campaignId = assertObjectId(id, "campaign id");
  const c = await WhatsAppCampaign.findById(campaignId).lean();
  if (!c) throw notFound("Campaign not found");
  if (!["Completed", "Failed", "Paused", "Running"].includes(c.status)) throw badRequest("Retry is available once the campaign has run");
  const failed = await WhatsAppCampaignRecipient.find({ campaignId, status: "Failed" }).select("_id messageId").lean();
  if (!failed.length) throw badRequest("No failed recipients to retry");
  await WhatsAppCampaignRecipient.updateMany(
    { _id: { $in: failed.map((f) => f._id) } },
    { $set: { status: "Pending", error: "", failedAt: null, messageId: null, providerMessageId: "", lockedUntil: null } }
  );
  if (c.status !== "Running" && c.status !== "Paused") {
    await WhatsAppCampaign.updateOne({ _id: campaignId }, { $set: { status: "Queued", completedAt: null, updatedBy: by } });
  }
  notifyAdmin("campaign", { campaignId: String(campaignId) });
  return { requeued: failed.length, campaign: await getCampaign(id) };
}

export async function deleteCampaign(id) {
  const c = await WhatsAppCampaign.findById(assertObjectId(id, "campaign id")).lean();
  if (!c) throw notFound("Campaign not found");
  if (["Queued", "Running"].includes(c.status)) throw badRequest("Pause or cancel the campaign before deleting it");
  await WhatsAppCampaignRecipient.deleteMany({ campaignId: c._id });
  await WhatsAppCampaign.deleteOne({ _id: c._id });
  return { deleted: true };
}

const csvCell = (v) => {
  const s = String(v ?? "");
  // Neutralise spreadsheet formulas and quote everything
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export async function exportCampaignCsv(id) {
  const campaign = await getCampaign(id);
  const header = ["Name", "Phone", "Course", "Batch", "Source", "Status", "Sent At", "Delivered At", "Read At", "Failed At", "Error / Skip reason"];
  const lines = [header.map(csvCell).join(",")];
  const cursor = WhatsAppCampaignRecipient.find({ campaignId: campaign._id }).sort({ _id: 1 }).lean().cursor();
  const iso = (d) => (d ? new Date(d).toISOString() : "");
  for await (const r of cursor) {
    lines.push(
      [r.name, r.phone, r.course, r.batch, r.sourceType, r.status, iso(r.sentAt), iso(r.deliveredAt), iso(r.readAt), iso(r.failedAt), r.error || r.skipReason]
        .map(csvCell)
        .join(",")
    );
  }
  const filename = `whatsapp-campaign-${campaign.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
  return { filename, csv: `﻿${lines.join("\r\n")}` }; // BOM so Excel reads UTF-8
}

