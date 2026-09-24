import mongoose from "mongoose";
import * as service from "./staff.service.js";
import { normalizeStaffPayload, validateStaffPayload } from "./staff.validation.js";

function getEditor(req) {
  return req.masterAdmin?.email || "master-admin";
}

function badObjectId(id) {
  return !mongoose.Types.ObjectId.isValid(id);
}

/** Same shape as faculty.controller.js's handleError — trusts a thrown
 * err.status (400/404/409 from the service/validation layer), and catches a
 * raw Mongo duplicate-key error that slipped past the pre-check as a 409
 * too, so neither path leaks `E11000 ...` or a stack trace to the frontend. */
function handleError(res, err, fallback) {
  console.error(fallback, err);
  if (err?.code === 11000) {
    return res.status(409).json({ success: false, message: "A record with these details already exists" });
  }
  const status = err?.status || 500;
  return res.status(status).json({ success: false, message: err?.message || fallback });
}

// ---------------------------------------------------------------------------
// Staff CRUD
// ---------------------------------------------------------------------------

export async function getStaffListController(req, res) {
  try {
    const data = await service.listStaff({
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      status: req.query.status,
      departmentId: req.query.departmentId,
      designationId: req.query.designationId,
      branch: req.query.branch,
      employmentType: req.query.employmentType,
      workMode: req.query.workMode,
      joiningYear: req.query.joiningYear,
      probation: req.query.probation,
      sort: req.query.sort,
      archived: req.query.archived,
    });
    return res.json({ success: true, message: "Staff fetched", ...data });
  } catch (err) {
    return handleError(res, err, "Failed to fetch staff");
  }
}

export async function getStaffStatsController(_req, res) {
  try {
    const stats = await service.getStaffStatsOverview();
    return res.json({ success: true, message: "Stats fetched", stats });
  } catch (err) {
    return handleError(res, err, "Failed to fetch staff stats");
  }
}

export async function getStaffMetaController(_req, res) {
  try {
    const meta = await service.getStaffMeta();
    return res.json({ success: true, message: "Meta fetched", ...meta });
  } catch (err) {
    return handleError(res, err, "Failed to fetch staff metadata");
  }
}

export async function getStaffController(req, res) {
  try {
    const entry = await service.getStaffById(req.params.id);
    if (!entry) return res.status(404).json({ success: false, message: "Staff member not found" });
    return res.json({ success: true, message: "Staff fetched", entry });
  } catch (err) {
    return handleError(res, err, "Failed to fetch staff member");
  }
}

export async function createStaffController(req, res) {
  try {
    const payload = normalizeStaffPayload(req.body);
    const validationError = validateStaffPayload(payload, { isCreate: true });
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    const entry = await service.createStaff(payload, getEditor(req));
    return res.status(201).json({ success: true, message: "Staff member added", entry });
  } catch (err) {
    return handleError(res, err, "Failed to create staff member");
  }
}

export async function updateStaffController(req, res) {
  try {
    if (badObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff id" });
    }
    const payload = normalizeStaffPayload(req.body);
    const validationError = validateStaffPayload(payload, { isCreate: false });
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    const entry = await service.updateStaff(req.params.id, payload, getEditor(req));
    return res.json({ success: true, message: "Staff member updated", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update staff member");
  }
}

export async function updateStaffStatusController(req, res) {
  try {
    if (badObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff id" });
    }
    const entry = await service.updateStaffStatus(req.params.id, req.body?.status, getEditor(req));
    return res.json({ success: true, message: "Staff status updated", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update staff status");
  }
}

export async function archiveStaffController(req, res) {
  try {
    if (badObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff id" });
    }
    const entry = await service.archiveStaff(req.params.id, getEditor(req));
    return res.json({ success: true, message: "Staff member archived (kept in database)", entry });
  } catch (err) {
    return handleError(res, err, "Failed to archive staff member");
  }
}

export async function restoreStaffController(req, res) {
  try {
    if (badObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff id" });
    }
    const entry = await service.restoreStaff(req.params.id, getEditor(req));
    return res.json({ success: true, message: "Staff member restored", entry });
  } catch (err) {
    return handleError(res, err, "Failed to restore staff member");
  }
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export async function getStaffDepartmentsController(req, res) {
  try {
    const rows = await service.listStaffDepartments({ search: req.query.search, status: req.query.status });
    return res.json({ success: true, message: "Departments fetched", rows });
  } catch (err) {
    return handleError(res, err, "Failed to fetch departments");
  }
}

export async function createStaffDepartmentController(req, res) {
  try {
    const payload = {
      name: String(req.body?.name || "").trim(),
      code: String(req.body?.code || "").trim().toUpperCase(),
      headName: String(req.body?.headName || "").trim(),
      description: String(req.body?.description || "").trim(),
      status: req.body?.status === "Inactive" ? "Inactive" : "Active",
    };
    const entry = await service.createStaffDepartment(payload, getEditor(req));
    return res.status(201).json({ success: true, message: "Department created", entry });
  } catch (err) {
    return handleError(res, err, "Failed to create department");
  }
}

export async function updateStaffDepartmentController(req, res) {
  try {
    if (badObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid department id" });
    const payload = {
      name: String(req.body?.name || "").trim(),
      code: String(req.body?.code || "").trim().toUpperCase(),
      headName: String(req.body?.headName || "").trim(),
      description: String(req.body?.description || "").trim(),
      status: req.body?.status === "Inactive" ? "Inactive" : "Active",
    };
    const entry = await service.updateStaffDepartment(req.params.id, payload, getEditor(req));
    return res.json({ success: true, message: "Department updated", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update department");
  }
}

export async function setStaffDepartmentStatusController(req, res) {
  try {
    if (badObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid department id" });
    const status = req.body?.status === "Inactive" ? "Inactive" : "Active";
    const entry = await service.setStaffDepartmentStatus(req.params.id, status, getEditor(req));
    return res.json({ success: true, message: "Department status updated", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update department status");
  }
}

export async function archiveStaffDepartmentController(req, res) {
  try {
    if (badObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid department id" });
    const entry = await service.archiveStaffDepartment(req.params.id, getEditor(req));
    return res.json({ success: true, message: "Department archived", entry });
  } catch (err) {
    return handleError(res, err, "Failed to archive department");
  }
}

// ---------------------------------------------------------------------------
// Designations
// ---------------------------------------------------------------------------

export async function getStaffDesignationsController(req, res) {
  try {
    const rows = await service.listStaffDesignations({
      search: req.query.search,
      status: req.query.status,
      departmentId: req.query.departmentId,
    });
    return res.json({ success: true, message: "Designations fetched", rows });
  } catch (err) {
    return handleError(res, err, "Failed to fetch designations");
  }
}

export async function createStaffDesignationController(req, res) {
  try {
    const payload = {
      name: String(req.body?.name || "").trim(),
      code: String(req.body?.code || "").trim().toUpperCase(),
      departmentId: req.body?.departmentId || null,
      description: String(req.body?.description || "").trim(),
      level: Number(req.body?.level) || 0,
      status: req.body?.status === "Inactive" ? "Inactive" : "Active",
    };
    const entry = await service.createStaffDesignation(payload, getEditor(req));
    return res.status(201).json({ success: true, message: "Designation created", entry });
  } catch (err) {
    return handleError(res, err, "Failed to create designation");
  }
}

export async function updateStaffDesignationController(req, res) {
  try {
    if (badObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid designation id" });
    const payload = {
      name: String(req.body?.name || "").trim(),
      code: String(req.body?.code || "").trim().toUpperCase(),
      departmentId: req.body?.departmentId || null,
      description: String(req.body?.description || "").trim(),
      level: Number(req.body?.level) || 0,
      status: req.body?.status === "Inactive" ? "Inactive" : "Active",
    };
    const entry = await service.updateStaffDesignation(req.params.id, payload, getEditor(req));
    return res.json({ success: true, message: "Designation updated", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update designation");
  }
}

export async function setStaffDesignationStatusController(req, res) {
  try {
    if (badObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid designation id" });
    const status = req.body?.status === "Inactive" ? "Inactive" : "Active";
    const entry = await service.setStaffDesignationStatus(req.params.id, status, getEditor(req));
    return res.json({ success: true, message: "Designation status updated", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update designation status");
  }
}

export async function archiveStaffDesignationController(req, res) {
  try {
    if (badObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid designation id" });
    const entry = await service.archiveStaffDesignation(req.params.id, getEditor(req));
    return res.json({ success: true, message: "Designation archived", entry });
  } catch (err) {
    return handleError(res, err, "Failed to archive designation");
  }
}
