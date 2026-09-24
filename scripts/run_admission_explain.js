#!/usr/bin/env node
/*
Run representative explain("executionStats") checks against the admissions collection.
Outputs JSON with explain results and simple payload-size samples.

Usage:
  node scripts/run_admission_explain.js --mongoUri="mongodb://..." --out=./explain_results.json --limit=25

Requires: NODE environment with network access to the MongoDB instance.
*/

import mongoose from "mongoose";
import fs from "fs";
import { argv } from "process";

function parseArg(name, def = null) {
  const p = argv.find((a) => a.startsWith(`--${name}=`));
  if (!p) return def;
  return p.split("=").slice(1).join("=");
}

const mongoUri = parseArg("mongoUri") || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/growskillstech";
const outFile = parseArg("out") || "./admission_explain_results.json";
const limit = Number(parseArg("limit") || 25);
const courseIdArg = parseArg("courseId") || parseArg("course") || null;
const univIdArg = parseArg("univId") || parseArg("universityId") || null;
const batchIdArg = parseArg("batchId") || null;
const sessionArg = parseArg("session") || null;
const searchArg = parseArg("search") || parseArg("q") || null;

async function run() {
  console.log("Connecting to MongoDB (using environment configuration)");
  await mongoose.connect(mongoUri, { dbName: parseArg("db") || undefined });
  const db = mongoose.connection.db;

  // Import the project's Admission model to obtain the exact collection name and schema
  let AdmissionModel = null;
  try {
    const mod = await import("../src/models/Admission.js");
    AdmissionModel = mod.Admission;
  } catch (err) {
    console.warn("Warning: failed to import Admission model; falling back to 'admissions' collection", err.message || err);
  }

  const collectionName = AdmissionModel && AdmissionModel.collection && AdmissionModel.collection.name
    ? AdmissionModel.collection.name
    : "admissions";

  const coll = db.collection(collectionName);

  const indexes = await coll.indexes();
  const docCount = await coll.countDocuments();

  // Discover real sample values from the collection
  const sample = {};
  const anyDoc = await coll.findOne({}, { projection: { applicant: 1, admissionId: 1, email: 1, phone: 1, details: 1 } });
  if (anyDoc) {
    sample.any = anyDoc;
    sample.searchTerm = anyDoc.applicant || anyDoc.admissionId || anyDoc.email || anyDoc.phone || null;
  }

  sample.courseIds = await coll.distinct("details.courseId").catch(() => []);
  sample.universityIds = await coll.distinct("details.universityId").catch(() => []);
  sample.batchIds = await coll.distinct("details.batchId").catch(() => []);
  sample.sessions = await coll.distinct("details.session").catch(() => []);
  sample.currentSemesters = await coll.distinct("details.currentSemester").catch(() => []);

  // Helper to choose a value or null
  const pick = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);
  const chosen = {
    courseId: pick(sample.courseIds),
    universityId: pick(sample.universityIds),
    batchId: pick(sample.batchIds),
    session: pick(sample.sessions) || (anyDoc && anyDoc.details && anyDoc.details.session) || null,
    currentSemester: pick(sample.currentSemesters) || (anyDoc && anyDoc.details && anyDoc.details.currentSemester) || null,
    searchTerm: sample.searchTerm || null,
  };

  // Prepare results container and metadata
  const results = { meta: { collectionName, docCount, indexes, chosen }, queries: [] };

  const queries = [];

  function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function collectPlanStages(plan, out = new Set()) {
    if (!plan || typeof plan !== "object") return out;
    if (plan.stage) out.add(plan.stage);
    if (plan.inputStage) collectPlanStages(plan.inputStage, out);
    if (Array.isArray(plan.inputStages)) plan.inputStages.forEach((p) => collectPlanStages(p, out));
    if (plan.child) collectPlanStages(plan.child, out);
    if (Array.isArray(plan.shards)) plan.shards.forEach((s) => collectPlanStages(s, out));
    return out;
  }

  // Query A — Default student list: status only, sort by admissionDate
  queries.push({
    name: "A-default-list",
    filter: { status: { $exists: true } },
    sort: { admissionDate: -1 },
    limit,
  });

  // Query B — Course filter
  queries.push({
    name: "B-course-filter",
    filter: chosen.courseId ? { "details.courseId": chosen.courseId, status: { $exists: true } } : null,
    sort: { admissionDate: -1 },
    limit,
    notTestable: !chosen.courseId,
  });

  // Query C — University filter
  queries.push({
    name: "C-university-filter",
    filter: chosen.universityId ? { "details.universityId": chosen.universityId, status: { $exists: true } } : null,
    sort: { admissionDate: -1 },
    limit,
    notTestable: !chosen.universityId,
  });

  // Query D — Batch filter
  queries.push({
    name: "D-batch-filter",
    filter: chosen.batchId ? { "details.batchId": chosen.batchId, status: { $exists: true } } : null,
    sort: { admissionDate: -1 },
    limit,
    notTestable: !chosen.batchId,
  });

  // Query E — Session filter: test both sessionKey and details.session
  queries.push({ name: "E-sessionTop", filter: chosen.session ? { sessionKey: chosen.session, status: { $exists: true } } : null, sort: { admissionDate: -1 }, limit, notTestable: !chosen.session });
  queries.push({ name: "E-sessionDetails", filter: chosen.session ? { "details.session": chosen.session, status: { $exists: true } } : null, sort: { admissionDate: -1 }, limit, notTestable: !chosen.session });

  // Query F — Course + Session
  queries.push({ name: "F-course-session", filter: (chosen.courseId && chosen.session) ? { "details.courseId": chosen.courseId, "details.session": chosen.session, status: { $exists: true } } : null, sort: { admissionDate: -1 }, limit, notTestable: !(chosen.courseId && chosen.session) });

  // Query G — Search (regex across fields)
  // Query G — realistic search across fields using a sample search term
  const searchTerm = chosen.searchTerm ? String(chosen.searchTerm).trim() : null;
  const rx = searchTerm ? new RegExp(escapeRegex(searchTerm.slice(0, Math.max(2, Math.floor(searchTerm.length / 3)))), "i") : null;
  queries.push({
    name: "G-search-regex",
    filter: rx ? { $or: [ { applicant: rx }, { admissionId: rx }, { email: rx }, { phone: rx }, { "details.registrationNo": rx } ] } : null,
    sort: { admissionDate: -1 },
    limit,
    notTestable: !rx,
    searchTermUsed: searchTerm || null,
  });

  // results already prepared above with collection metadata

  for (const q of queries) {
    if (!q.filter || q.notTestable) {
      results.queries.push({ name: q.name, notTestable: true, reason: "no sample value available for this filter", sampleUsed: q.searchTermUsed || null });
      console.log(`Skipping ${q.name} — not testable (no sample value)`);
      continue;
    }
    try {
      const cursor = coll.find(q.filter).sort(q.sort).limit(q.limit);
      const explain = await cursor.explain("executionStats");

      // Also sample actual returned docs with API projection used by students list
      const projection = { admissionId: 1, applicant: 1, email: 1, phone: 1, course: 1, college: 1, status: 1, admissionDate: 1, details: 1 };
      const docs = await coll.find(q.filter).project(projection).sort(q.sort).limit(q.limit).toArray();
      const payloadSize = Buffer.byteLength(JSON.stringify(docs), "utf8");

      const execStats = explain.executionStats || {};
      const qp = explain.queryPlanner || {};
      const winningPlan = qp.winningPlan || null;
      const stages = Array.from(collectPlanStages(winningPlan || execStats.executionStages || {}));
      const hasCOLLSCAN = stages.includes("COLLSCAN");
      const hasIXSCAN = stages.includes("IXSCAN");
      const hasSORT = stages.includes("SORT") || stages.includes("SORT_KEY_LIMIT");

      const entry = {
        name: q.name,
        filter: q.filter,
        sort: q.sort,
        limit: q.limit,
        sampleCount: docs.length,
        samplePayloadBytes: payloadSize,
        explainSummary: {
          executionTimeMillis: execStats.executionTimeMillis || execStats.executionTimeMillis || execStats.executionMillis || 0,
          nReturned: execStats.nReturned !== undefined ? execStats.nReturned : docs.length,
          totalDocsExamined: execStats.totalDocsExamined || 0,
          totalKeysExamined: execStats.totalKeysExamined || 0,
          winningPlan: winningPlan,
          stages: stages,
          hasCOLLSCAN,
          hasIXSCAN,
          hasSORT,
        },
        fullExplain: explain,
      };

      results.queries.push(entry);
      console.log(`Completed ${q.name} — nReturned=${docs.length} payloadBytes=${payloadSize} execMs=${entry.explainSummary.executionTimeMillis}`);
    } catch (err) {
      console.error(`Error for ${q.name}:`, err.message || err);
      results.queries.push({ name: q.name, error: String(err.message || err) });
    }
  }

  fs.writeFileSync(outFile, JSON.stringify(results, null, 2), "utf8");
  console.log("Explains written to", outFile);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
