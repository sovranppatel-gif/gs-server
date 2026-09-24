import { University } from "./universities.model.js";

function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lowercased, whitespace-collapsed form used only for duplicate comparison —
 * never shown to the admin and never replaces the display value they typed. */
function normalizeForCompare(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function toRow(doc) {
  const d = doc?.toObject ? doc.toObject() : doc;
  // shortNameNormalized/registrationNumberNormalized are bookkeeping only —
  // strip them explicitly rather than relying on schema `select: false`,
  // which doesn't apply to a document already in memory (e.g. straight out
  // of .create()).
  const { shortNameNormalized, registrationNumberNormalized, ...rest } = d;
  return {
    ...rest,
    _id: String(d._id),
    id: String(d._id),
  };
}

/** Translates a MongoDB duplicate-key error (the race-condition safety net —
 * see the partial unique indexes in universities.model.js) into the same
 * clean, field-specific message assertNoDuplicateUniversity() would have
 * given if it had won the race. Never lets `E11000 duplicate key ...` reach
 * the frontend. */
function translateDuplicateKeyError(err) {
  if (err?.code !== 11000) return err;
  const key = Object.keys(err.keyPattern || err.keyValue || {})[0] || "";
  if (key.includes("shortName")) return conflict("A university with this short name already exists.");
  if (key.includes("registrationNumber")) {
    return conflict("A university with this registration number already exists.");
  }
  return conflict("A university with these details already exists.");
}

/** Pre-insert/update duplicate check. This is the path almost every request
 * actually takes — the partial unique indexes only need to fire for the rare
 * case of two admins submitting the same short name/registration number in
 * the same instant. */
async function assertNoDuplicateUniversity({ shortName, registrationNumber, excludeId = null }) {
  const shortNameNormalized = normalizeForCompare(shortName);
  const registrationNumberNormalized = normalizeForCompare(registrationNumber);

  const or = [];
  if (shortNameNormalized) or.push({ shortNameNormalized });
  if (registrationNumberNormalized) or.push({ registrationNumberNormalized });
  if (!or.length) return;

  const query = { softDelete: false, $or: or };
  if (excludeId) query._id = { $ne: excludeId };

  const existing = await University.findOne(query)
    .select("shortNameNormalized registrationNumberNormalized")
    .maxTimeMS(5000)
    .lean();
  if (!existing) return;

  if (shortNameNormalized && existing.shortNameNormalized === shortNameNormalized) {
    throw conflict("A university with this short name already exists.");
  }
  if (registrationNumberNormalized && existing.registrationNumberNormalized === registrationNumberNormalized) {
    throw conflict("A university with this registration number already exists.");
  }
}

async function computeStats(matchQuery) {
  const agg = await University.aggregate([
    { $match: matchQuery },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).option({ maxTimeMS: 5000 });

  const byStatus = Object.fromEntries(agg.map((row) => [row._id, row.count]));
  return {
    total: agg.reduce((sum, row) => sum + row.count, 0),
    active: byStatus.Active || 0,
    inactive: byStatus.Inactive || 0,
    draft: byStatus.Draft || 0,
  };
}

const LIST_PROJECTION =
  "name shortName universityCode registrationNumber affiliationNumber status city state " +
  "contactPerson contactPhone contactEmail website remarks createdAt updatedAt createdBy updatedBy";

/**
 * `page`/`limit` are left undefined by callers that just want the full,
 * unpaginated list (every existing dropdown across Courses/Faculty/Students —
 * see universities.controller.js) — passing neither preserves that contract
 * exactly (rows = every match, sorted, pagination describes that one page).
 * Only the Universities screen itself passes both, to get a real paginated,
 * server-side page.
 */
export async function listUniversities({ search = "", status = "", page, limit } = {}) {
  const query = { softDelete: false };
  if (status) query.status = status;

  if (search) {
    const rx = new RegExp(escapeRegex(search.trim()), "i");
    query.$or = [
      { name: rx },
      { shortName: rx },
      { universityCode: rx },
      { registrationNumber: rx },
      { affiliationNumber: rx },
      { city: rx },
      { contactEmail: rx },
    ];
  }

  const paginate = page != null || limit != null;
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(200, Math.max(1, Number(limit) || 20));

  let cursor = University.find(query).select(LIST_PROJECTION).sort({ name: 1 });
  if (paginate) cursor = cursor.skip((pageNum - 1) * limitNum).limit(limitNum);

  const [total, docs, stats] = await Promise.all([
    University.countDocuments(query).maxTimeMS(8000),
    cursor.lean().maxTimeMS(8000),
    // Stats intentionally reflect the current search term (matches the
    // behavior this list already had) but never the status filter, so the
    // four stat tiles always show where every status stands — not just the
    // one currently selected.
    computeStats({ softDelete: false, ...(query.$or ? { $or: query.$or } : {}) }),
  ]);

  const rows = docs.map(toRow);

  return {
    rows,
    stats,
    pagination: paginate
      ? { page: pageNum, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) }
      : { page: 1, limit: total, total, totalPages: 1 },
  };
}

export async function getUniversityById(id) {
  const doc = await University.findOne({ _id: id, softDelete: false }).maxTimeMS(5000).lean();
  return doc ? toRow(doc) : null;
}

export async function createUniversity(payload) {
  await assertNoDuplicateUniversity({ shortName: payload.shortName, registrationNumber: payload.registrationNumber });

  try {
    // Activity-log/socket broadcast for this write is handled by the global
    // activityLogger middleware (see middleware/activityLogger.js, which
    // already maps /api/universities to the "universities" section) — adding
    // a second createActivityLog call here would double-log every request,
    // the same way it would for Courses, which relies on that same middleware.
    const created = await University.create({
      ...payload,
      shortNameNormalized: normalizeForCompare(payload.shortName),
      registrationNumberNormalized: normalizeForCompare(payload.registrationNumber),
    });
    return toRow(created);
  } catch (err) {
    throw translateDuplicateKeyError(err);
  }
}

export async function updateUniversity(id, payload) {
  await assertNoDuplicateUniversity({
    shortName: payload.shortName,
    registrationNumber: payload.registrationNumber,
    excludeId: id,
  });

  try {
    const updated = await University.findOneAndUpdate(
      { _id: id, softDelete: false },
      {
        ...payload,
        shortNameNormalized: normalizeForCompare(payload.shortName),
        registrationNumberNormalized: normalizeForCompare(payload.registrationNumber),
      },
      { new: true }
    );
    return updated ? toRow(updated) : null;
  } catch (err) {
    throw translateDuplicateKeyError(err);
  }
}

export async function deactivateUniversity(id, updatedBy) {
  const updated = await University.findOneAndUpdate(
    { _id: id, softDelete: false },
    { status: "Inactive", updatedBy },
    { new: true }
  );
  return updated ? toRow(updated) : null;
}

export async function activateUniversity(id, updatedBy) {
  const updated = await University.findOneAndUpdate(
    { _id: id, softDelete: false },
    { status: "Active", updatedBy },
    { new: true }
  );
  return updated ? toRow(updated) : null;
}
