import { WhatsAppTemplate, WA_TEMPLATE_CATEGORIES, WA_TEMPLATE_STATUSES } from "../models/whatsappTemplate.model.js";
import { fetchTemplates, submitTemplate } from "../whatsapp.client.js";
import { isDryRun } from "../whatsapp.config.js";
import { assertObjectId, badRequest, cleanString, escapeRegex, HttpError, notFound } from "../whatsapp.utils.js";

const NAME_RE = /^[a-z0-9_]{1,512}$/;

/** Replaces {{1}}, {{2}}… with params (missing ones stay visible as {{n}}). */
export function renderTemplateBody(bodyText, params = []) {
  return String(bodyText || "").replace(/\{\{(\d+)\}\}/g, (m, n) => {
    const v = params[Number(n) - 1];
    return v === undefined || v === null || v === "" ? m : String(v);
  });
}

export function countBodyVariables(bodyText) {
  const nums = [...String(bodyText || "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

/**
 * Whether a template may be used to message someone OUTSIDE the 24h window.
 * Live: only Meta-approved templates. Dry run: drafts allowed for testing,
 * flagged so the UI can warn they would be blocked live.
 */
export function templateSendability(template) {
  const approved = template?.source === "meta" && template?.status === "APPROVED";
  if (approved) return { allowed: true, approved: true, note: "" };
  if (isDryRun()) return { allowed: true, approved: false, note: "Not Meta-approved — allowed only because dry run is on; live sending would block it." };
  return { allowed: false, approved: false, note: "Only Meta-approved templates can be sent. Sync templates from Meta or wait for approval." };
}

function componentsToFields(components = []) {
  const find = (type) => components.find((c) => String(c.type).toUpperCase() === type);
  const header = find("HEADER");
  return {
    headerText: header?.format === "TEXT" ? header.text || "" : "",
    bodyText: find("BODY")?.text || "",
    footerText: find("FOOTER")?.text || "",
    buttons: find("BUTTONS")?.buttons || [],
  };
}

function fieldsToComponents({ headerText, bodyText, footerText, variables = [] }) {
  const components = [];
  if (headerText) components.push({ type: "HEADER", format: "TEXT", text: headerText });
  const body = { type: "BODY", text: bodyText };
  const samples = [...variables].sort((a, b) => a.index - b.index).map((v) => v.sample || v.label || `value${v.index}`);
  if (samples.length) body.example = { body_text: [samples] };
  components.push(body);
  if (footerText) components.push({ type: "FOOTER", text: footerText });
  return components;
}

function normalizePayload(body = {}) {
  const name = cleanString(body.name, 512).toLowerCase().replace(/\s+/g, "_");
  if (!NAME_RE.test(name)) throw badRequest("Template name may only contain lowercase letters, numbers and underscores");
  const bodyText = cleanString(body.bodyText, 1024);
  if (!bodyText) throw badRequest("Template body is required");
  const category = WA_TEMPLATE_CATEGORIES.includes(body.category) ? body.category : "UTILITY";
  const varCount = countBodyVariables(bodyText);
  const given = Array.isArray(body.variables) ? body.variables : [];
  const variables = Array.from({ length: varCount }, (_, i) => {
    const v = given.find((x) => Number(x.index) === i + 1) || {};
    return { index: i + 1, label: cleanString(v.label, 60) || `Variable ${i + 1}`, sample: cleanString(v.sample, 200) };
  });
  return {
    name,
    language: cleanString(body.language, 10) || "en",
    category,
    headerText: cleanString(body.headerText, 60),
    bodyText,
    footerText: cleanString(body.footerText, 60),
    variables,
  };
}

export async function listTemplates(query = {}) {
  const filter = {};
  if (query.status && WA_TEMPLATE_STATUSES.includes(query.status)) filter.status = query.status;
  if (query.source === "meta" || query.source === "local") filter.source = query.source;
  if (query.search) filter.name = new RegExp(escapeRegex(cleanString(query.search, 60)), "i");
  const rows = await WhatsAppTemplate.find(filter).sort({ updatedAt: -1 }).limit(500).lean();
  return rows.map((t) => ({ ...t, sendability: templateSendability(t), preview: renderTemplateBody(t.bodyText, t.variables.map((v) => v.sample || `[${v.label}]`)) }));
}

export async function getTemplate(id) {
  const t = await WhatsAppTemplate.findById(assertObjectId(id, "template id")).lean();
  if (!t) throw notFound("Template not found");
  return { ...t, sendability: templateSendability(t) };
}

export async function createTemplate(body, by) {
  const data = normalizePayload(body);
  const doc = await WhatsAppTemplate.create({ ...data, components: fieldsToComponents(data), status: "DRAFT", source: "local", createdBy: by, updatedBy: by });
  return doc.toObject();
}

export async function updateTemplate(id, body, by) {
  const t = await WhatsAppTemplate.findById(assertObjectId(id, "template id"));
  if (!t) throw notFound("Template not found");
  if (t.source === "meta" && t.status !== "REJECTED") {
    throw badRequest("Meta templates are edited in Meta Business Manager — sync to refresh them here");
  }
  const data = normalizePayload({ ...t.toObject(), ...body });
  Object.assign(t, data, { components: fieldsToComponents(data), updatedBy: by });
  if (t.source === "meta") Object.assign(t, { source: "local", status: "DRAFT", metaTemplateId: "" });
  await t.save();
  return t.toObject();
}

export async function deleteTemplate(id) {
  const t = await WhatsAppTemplate.findById(assertObjectId(id, "template id"));
  if (!t) throw notFound("Template not found");
  await t.deleteOne();
  return { deleted: true, note: t.source === "meta" ? "Removed locally only; the template still exists in Meta." : "" };
}

/** Pulls templates from Meta (read-only call) and mirrors them locally. */
export async function syncTemplatesFromMeta() {
  const result = await fetchTemplates();
  if (!result.ok) throw new HttpError(result.error.code === "NOT_CONFIGURED" ? 400 : 502, `Meta sync failed: ${result.error.message}`);
  let upserted = 0;
  const now = new Date();
  for (const row of result.data) {
    const fields = componentsToFields(row.components || []);
    const varCount = countBodyVariables(fields.bodyText);
    const status = WA_TEMPLATE_STATUSES.includes(row.status) ? row.status : "PENDING";
    const existing = await WhatsAppTemplate.findOne({ name: row.name, language: row.language }).select("variables").lean();
    const variables = Array.from({ length: varCount }, (_, i) => existing?.variables?.find((v) => v.index === i + 1) || { index: i + 1, label: `Variable ${i + 1}`, sample: "" });
    await WhatsAppTemplate.updateOne(
      { name: row.name, language: row.language },
      {
        $set: {
          ...fields,
          category: WA_TEMPLATE_CATEGORIES.includes(row.category) ? row.category : "UTILITY",
          status,
          source: "meta",
          metaTemplateId: String(row.id || ""),
          components: row.components || [],
          variables,
          lastSyncedAt: now,
          updatedBy: "meta-sync",
        },
        $setOnInsert: { createdBy: "meta-sync" },
      },
      { upsert: true }
    );
    upserted += 1;
  }
  return { synced: upserted };
}

export async function submitTemplateToMeta(id, by) {
  const t = await WhatsAppTemplate.findById(assertObjectId(id, "template id"));
  if (!t) throw notFound("Template not found");
  if (t.source === "meta" && t.status !== "REJECTED") throw badRequest("Template is already in Meta");
  const result = await submitTemplate({ name: t.name, language: t.language, category: t.category, components: fieldsToComponents(t) });
  if (!result.ok) throw new HttpError(result.error.code === "DRY_RUN" || result.error.code === "NOT_CONFIGURED" ? 400 : 502, result.error.message);
  Object.assign(t, {
    source: "meta",
    status: WA_TEMPLATE_STATUSES.includes(result.data?.status) ? result.data.status : "PENDING",
    metaTemplateId: String(result.data?.id || ""),
    updatedBy: by,
  });
  await t.save();
  return t.toObject();
}
