import * as service from "./academicDepartment.service.js";
import { normalizeDepartmentPayload, validateDepartmentPayload } from "./academicDepartment.validation.js";

function getEditor(req) {
  return req.masterAdmin?.email || "master-admin";
}

/** Same shape as faculty/staff controllers' handleError — trusts err.status
 * from the service layer and never leaks a raw E11000/stack to the client. */
function handleError(res, err, fallback) {
  if (!err?.status || err.status >= 500) console.error(fallback, err);
  if (err?.code === 11000) {
    return res.status(409).json({ success: false, message: "A department with these details already exists" });
  }
  const status = err?.status || 500;
  return res.status(status).json({ success: false, message: status >= 500 ? fallback : err.message || fallback });
}

export async function listDepartmentsController(req, res) {
  try {
    const data = await service.listDepartments({
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      status: req.query.status,
      sortBy: req.query.sortBy,
      sortOrder: req.query.sortOrder,
      export: req.query.export,
    });
    return res.json({ success: true, message: "Academic departments fetched", ...data });
  } catch (err) {
    return handleError(res, err, "Failed to fetch academic departments");
  }
}

export async function listDepartmentOptionsController(req, res) {
  try {
    const rows = await service.listDepartmentOptions({ includeInactive: req.query.activeOnly !== "1" });
    return res.json({ success: true, message: "Academic departments fetched", rows });
  } catch (err) {
    return handleError(res, err, "Failed to fetch academic departments");
  }
}

export async function getDepartmentStatsController(_req, res) {
  try {
    const stats = await service.getDepartmentStats();
    return res.json({ success: true, message: "Academic department stats fetched", stats });
  } catch (err) {
    return handleError(res, err, "Failed to fetch academic department stats");
  }
}

export async function getDepartmentController(req, res) {
  try {
    const entry = await service.getDepartmentById(req.params.id);
    return res.json({ success: true, message: "Academic department fetched", entry });
  } catch (err) {
    return handleError(res, err, "Failed to fetch academic department");
  }
}

export async function createDepartmentController(req, res) {
  try {
    const payload = normalizeDepartmentPayload(req.body);
    const validationError = validateDepartmentPayload(payload);
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    const entry = await service.createDepartment(payload, getEditor(req));
    return res.status(201).json({ success: true, message: "Academic department created", entry });
  } catch (err) {
    return handleError(res, err, "Failed to create academic department");
  }
}

export async function updateDepartmentController(req, res) {
  try {
    const payload = normalizeDepartmentPayload(req.body);
    const validationError = validateDepartmentPayload(payload);
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    const entry = await service.updateDepartment(req.params.id, payload, getEditor(req));
    return res.json({ success: true, message: "Academic department updated", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update academic department");
  }
}

export async function setDepartmentStatusController(req, res) {
  try {
    const entry = await service.setDepartmentStatus(req.params.id, req.body?.status, getEditor(req));
    return res.json({ success: true, message: `Academic department ${entry.status === "Active" ? "activated" : "deactivated"}`, entry });
  } catch (err) {
    return handleError(res, err, "Failed to update academic department status");
  }
}

export async function setDepartmentHodController(req, res) {
  try {
    const hodId = req.body?.hodId ? String(req.body.hodId).trim() : null;
    const entry = await service.setDepartmentHod(req.params.id, hodId, getEditor(req));
    return res.json({ success: true, message: hodId ? "HOD assigned" : "HOD removed", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update HOD");
  }
}

export async function deleteDepartmentController(req, res) {
  try {
    const entry = await service.deleteDepartment(req.params.id, getEditor(req));
    return res.json({ success: true, message: "Academic department deleted", entry });
  } catch (err) {
    return handleError(res, err, "Failed to delete academic department");
  }
}

export async function listDepartmentFacultyController(req, res) {
  try {
    const data = await service.listDepartmentFaculty(req.params.id, {
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      status: req.query.status,
    });
    return res.json({ success: true, message: "Department faculty fetched", ...data });
  } catch (err) {
    return handleError(res, err, "Failed to fetch department faculty");
  }
}

export async function listDepartmentCoursesController(req, res) {
  try {
    const rows = await service.listDepartmentCourses(req.params.id);
    return res.json({ success: true, message: "Department courses fetched", rows });
  } catch (err) {
    return handleError(res, err, "Failed to fetch department courses");
  }
}

export async function listDepartmentStudentsController(req, res) {
  try {
    const data = await service.listDepartmentStudents(req.params.id, {
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
    });
    return res.json({ success: true, message: "Department students fetched", ...data });
  } catch (err) {
    return handleError(res, err, "Failed to fetch department students");
  }
}
