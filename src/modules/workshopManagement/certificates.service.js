import mongoose from "mongoose";
import { WorkshopCertificate, ensureWorkshopIndexes } from "./workshopManagement.model.js";
import { reserveNextSequence } from "../../lib/sequence.js";
import { HttpError } from "./workshopManagement.utils.js";
import { getSettings } from "./settings.service.js";
import { loadWorkshopContext, studentRow } from "./stats.service.js";

async function nextCertificateNumber() {
  const seq = await reserveNextSequence({
    key: "workshop-certificate",
    readMax: async () => {
      const [result] = await WorkshopCertificate.aggregate([
        { $match: { certificateNumber: { $regex: "^GST-WC-[0-9]+$" } } },
        {
          $project: {
            seq: { $convert: { input: { $substrCP: ["$certificateNumber", 7, 20] }, to: "int", onError: 0, onNull: 0 } },
          },
        },
        { $group: { _id: null, maxSeq: { $max: "$seq" } } },
      ]);
      return result?.maxSeq || 0;
    },
  });
  return `GST-WC-${String(seq).padStart(6, "0")}`;
}

function evaluate(row, { threshold, requireAllTasks, activeTasks, sessionsHeld }) {
  const reasons = [];
  if (!sessionsHeld) reasons.push("No sessions held yet");
  if (row.attendancePercent < threshold) reasons.push(`Attendance ${row.attendancePercent}% < ${threshold}%`);
  if (requireAllTasks && row.tasksCompleted < activeTasks) reasons.push(`Tasks ${row.tasksCompleted}/${activeTasks}`);
  return { eligible: reasons.length === 0, reasons };
}

export async function getEligibility() {
  const [ctx, settings, certificates] = await Promise.all([
    loadWorkshopContext({ withTasks: true }),
    getSettings(),
    WorkshopCertificate.find().lean(),
  ]);
  const byReg = new Map(certificates.map((c) => [c.registrationId, c]));
  const rules = {
    threshold: Number(settings.attendanceRequirementPercent) || 0,
    requireAllTasks: Boolean(settings.certificateRequireAllTasks),
    activeTasks: ctx.tasks.length,
    sessionsHeld: ctx.heldSessions.length,
  };

  const rows = ctx.students.map((student) => {
    const row = studentRow(ctx, student);
    const { eligible, reasons } = evaluate(row, rules);
    const cert = byReg.get(student.registrationId);
    return {
      ...row,
      eligible,
      reasons,
      certificate: cert
        ? { _id: cert._id, certificateNumber: cert.certificateNumber, status: cert.status, issuedAt: cert.issuedAt }
        : null,
    };
  });

  return {
    rules: { ...rules, certificatesEnabled: Boolean(settings.certificatesEnabled) },
    summary: {
      total: rows.length,
      eligible: rows.filter((r) => r.eligible).length,
      issued: rows.filter((r) => r.certificate?.status === "Issued").length,
    },
    rows,
  };
}

/** Issues only when enabled in Settings, only to eligible students, never twice. */
export async function issueCertificates(registrationObjectIds, adminEmail) {
  const settings = await getSettings();
  if (!settings.certificatesEnabled) {
    throw new HttpError(403, "Certificate issuing is turned off. Enable it in Workshop Settings first.");
  }
  const wanted = new Set((registrationObjectIds || []).map(String));
  if (!wanted.size) throw new HttpError(400, "Select at least one student");

  await ensureWorkshopIndexes();
  const { rows } = await getEligibility();
  const issued = [];
  const skipped = [];
  for (const row of rows) {
    if (!wanted.has(String(row._id))) continue;
    if (row.certificate) {
      skipped.push({ registrationId: row.registrationId, reason: "Already has a certificate" });
      continue;
    }
    if (!row.eligible) {
      skipped.push({ registrationId: row.registrationId, reason: row.reasons.join(", ") });
      continue;
    }
    const cert = await WorkshopCertificate.create({
      certificateNumber: await nextCertificateNumber(),
      registration: row._id,
      registrationId: row.registrationId,
      studentName: row.fullName,
      collegeName: row.collegeName,
      workshopName: settings.workshopName,
      attendancePercent: row.attendancePercent,
      tasksCompleted: row.tasksCompleted,
      issuedBy: adminEmail,
    });
    issued.push(cert.toObject());
  }
  return { issued, skipped };
}

export async function setCertificateStatus(id, status) {
  if (!mongoose.isValidObjectId(id)) return null;
  if (!["Issued", "Revoked"].includes(status)) throw new HttpError(400, "Invalid status");
  return WorkshopCertificate.findByIdAndUpdate(id, { $set: { status } }, { returnDocument: "after" }).lean();
}

export async function getCertificate(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  return WorkshopCertificate.findById(id).lean();
}
