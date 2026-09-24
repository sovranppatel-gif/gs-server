import mongoose from "mongoose";
import {
  activateUniversity,
  createUniversity,
  deactivateUniversity,
  getUniversityById,
  listUniversities,
  updateUniversity,
} from "./universities.service.js";
import {
  normalizeUniversityPayload,
  validateUniversityPayload,
} from "./universities.validation.js";

function getEditor(req) {
  return req.masterAdmin?.email || "master-admin";
}

function badObjectId(id) {
  return !mongoose.Types.ObjectId.isValid(id);
}

/** Mirrors faculty.controller.js's handleError: a thrown err.status (400/404/409
 * from the service/validation layer) is trusted as-is; a raw Mongo duplicate-key
 * error that slipped past the pre-check (the race-condition case the partial
 * unique indexes exist for) is translated to 409 here too, so neither path can
 * leak `E11000 ...` or a Mongoose stack trace to the frontend. */
function handleError(res, err, fallback) {
  console.error(fallback, err);
  if (err?.code === 11000) {
    return res.status(409).json({ success: false, message: "A record with these details already exists" });
  }
  const status = err?.status || 500;
  return res.status(status).json({ success: false, message: err?.message || fallback });
}

export async function getUniversitiesController(req, res) {
  try {
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();
    // page/limit are forwarded only when the caller actually sent them, so
    // every existing dropdown/list consumer that calls GET /api/universities
    // with no pagination params keeps getting the full, unpaginated rows
    // array it already relies on — only the Universities screen itself sends
    // both and gets a real server-side page back.
    const data = await listUniversities({
      search,
      status,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({
      success: true,
      message: "Universities fetched",
      rows: data.rows,
      stats: data.stats,
      pagination: data.pagination,
    });
  } catch (err) {
    return handleError(res, err, "Failed to fetch universities");
  }
}

export async function getUniversityController(req, res) {
  try {
    if (badObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid university id" });
    }
    const entry = await getUniversityById(req.params.id);
    if (!entry) {
      return res.status(404).json({ success: false, message: "University not found" });
    }
    return res.json({ success: true, message: "University fetched", entry });
  } catch (err) {
    return handleError(res, err, "Failed to fetch university");
  }
}

export async function createUniversityController(req, res) {
  try {
    const payload = normalizeUniversityPayload(req.body);
    const validationError = validateUniversityPayload(payload);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const editor = getEditor(req);
    const entry = await createUniversity({
      ...payload,
      createdBy: editor,
      updatedBy: editor,
    });

    return res.status(201).json({
      success: true,
      message: "University created",
      entry,
    });
  } catch (err) {
    return handleError(res, err, "Failed to create university");
  }
}

export async function updateUniversityController(req, res) {
  try {
    if (badObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid university id" });
    }

    const payload = normalizeUniversityPayload(req.body);
    const validationError = validateUniversityPayload(payload);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const entry = await updateUniversity(req.params.id, {
      ...payload,
      updatedBy: getEditor(req),
    });

    if (!entry) {
      return res.status(404).json({ success: false, message: "University not found" });
    }

    return res.json({ success: true, message: "University updated", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update university");
  }
}

export async function deleteUniversityController(req, res) {
  try {
    if (badObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid university id" });
    }

    // Soft hide only — keep record for historical student / affiliation data
    const entry = await deactivateUniversity(req.params.id, getEditor(req));
    if (!entry) {
      return res.status(404).json({ success: false, message: "University not found" });
    }

    return res.json({
      success: true,
      message: "University marked Inactive (kept in database)",
      entry,
    });
  } catch (err) {
    return handleError(res, err, "Failed to deactivate university");
  }
}

export async function activateUniversityController(req, res) {
  try {
    if (badObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid university id" });
    }

    const entry = await activateUniversity(req.params.id, getEditor(req));
    if (!entry) {
      return res.status(404).json({ success: false, message: "University not found" });
    }

    return res.json({
      success: true,
      message: "University activated",
      entry,
    });
  } catch (err) {
    return handleError(res, err, "Failed to activate university");
  }
}
