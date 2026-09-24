import * as service from "./faculty.service.js";
import { normalizeFacultyPayload, validateFacultyPayload } from "./faculty.validation.js";

function getEditor(req) {
  return req.masterAdmin?.email || "master-admin";
}

function handleError(res, err, fallback) {
  console.error(fallback, err);
  if (err?.code === 11000) {
    return res.status(409).json({ success: false, message: "A record with these details already exists" });
  }
  const status = err.status || 500;
  return res.status(status).json({ success: false, message: err.message || fallback });
}

// ---------------------------------------------------------------------------
// Faculty CRUD
// ---------------------------------------------------------------------------

export async function getFacultiesController(req, res) {
  try {
    const data = await service.listFaculties({
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      status: req.query.status,
      designation: req.query.designation,
      department: req.query.department,
      universityId: req.query.universityId,
      courseId: req.query.courseId,
      export: req.query.export,
    });
    return res.json({ success: true, message: "Faculty fetched", ...data });
  } catch (err) {
    return handleError(res, err, "Failed to fetch faculty");
  }
}

export async function getFacultyStatsController(_req, res) {
  try {
    const stats = await service.getFacultyStatsOverview();
    return res.json({ success: true, message: "Stats fetched", stats });
  } catch (err) {
    return handleError(res, err, "Failed to fetch faculty stats");
  }
}

export async function getFacultyMetaController(_req, res) {
  try {
    const meta = await service.getFacultyMeta();
    return res.json({ success: true, message: "Meta fetched", ...meta });
  } catch (err) {
    return handleError(res, err, "Failed to fetch faculty metadata");
  }
}

export async function getFacultyController(req, res) {
  try {
    const entry = await service.getFacultyById(req.params.id);
    if (!entry) return res.status(404).json({ success: false, message: "Faculty not found" });
    return res.json({ success: true, message: "Faculty fetched", entry });
  } catch (err) {
    return handleError(res, err, "Failed to fetch faculty");
  }
}

export async function createFacultyController(req, res) {
  try {
    const payload = normalizeFacultyPayload(req.body);
    const validationError = validateFacultyPayload(payload, { isCreate: true });
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    const entry = await service.createFaculty(payload, getEditor(req));
    return res.status(201).json({ success: true, message: "Faculty added", entry });
  } catch (err) {
    return handleError(res, err, "Failed to create faculty");
  }
}

export async function updateFacultyController(req, res) {
  try {
    const payload = normalizeFacultyPayload(req.body);
    const validationError = validateFacultyPayload(payload, { isCreate: false });
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    const entry = await service.updateFaculty(req.params.id, payload, getEditor(req));
    return res.json({ success: true, message: "Faculty updated", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update faculty");
  }
}

export async function updateFacultyStatusController(req, res) {
  try {
    const entry = await service.updateFacultyStatus(req.params.id, req.body?.status, getEditor(req));
    return res.json({ success: true, message: "Faculty status updated", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update faculty status");
  }
}

export async function deleteFacultyController(req, res) {
  try {
    const entry = await service.deleteFaculty(req.params.id, getEditor(req));
    return res.json({ success: true, message: "Faculty archived", entry });
  } catch (err) {
    return handleError(res, err, "Failed to archive faculty");
  }
}

export async function uploadFacultyPhotoController(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });
    const url = `/uploads/faculty/${req.file.filename}`;
    return res.json({ success: true, message: "Photo uploaded", data: { url } });
  } catch (err) {
    return handleError(res, err, "Failed to upload photo");
  }
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export async function getFacultyAssignmentsController(req, res) {
  try {
    const data = await service.getFacultyAssignments(req.params.id);
    return res.json({ success: true, message: "Assignments fetched", ...data });
  } catch (err) {
    return handleError(res, err, "Failed to fetch assignments");
  }
}

export async function getAllFacultyAssignmentsController(req, res) {
  try {
    const data = await service.getAllFacultyAssignments({
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      status: req.query.status,
    });
    return res.json({ success: true, message: "Assignments fetched", ...data });
  } catch (err) {
    return handleError(res, err, "Failed to fetch assignments");
  }
}

export async function createFacultyAssignmentController(req, res) {
  try {
    const entry = await service.createFacultyAssignment(req.params.id, req.body || {}, getEditor(req));
    return res.status(201).json({ success: true, message: "Assignment added", entry });
  } catch (err) {
    return handleError(res, err, "Failed to create assignment");
  }
}

export async function updateFacultyAssignmentController(req, res) {
  try {
    const entry = await service.updateFacultyAssignment(req.params.assignmentId, req.body || {}, getEditor(req));
    return res.json({ success: true, message: "Assignment updated", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update assignment");
  }
}

export async function updateFacultyAssignmentStatusController(req, res) {
  try {
    const entry = await service.updateFacultyAssignmentStatus(req.params.assignmentId, req.body?.status, getEditor(req));
    return res.json({ success: true, message: "Assignment status updated", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update assignment status");
  }
}

export async function deleteFacultyAssignmentController(req, res) {
  try {
    const entry = await service.deleteFacultyAssignment(req.params.assignmentId, getEditor(req));
    return res.json({ success: true, message: "Assignment removed", entry });
  } catch (err) {
    return handleError(res, err, "Failed to remove assignment");
  }
}

// ---------------------------------------------------------------------------
// Timetable
// ---------------------------------------------------------------------------

export async function getFacultyTimetableController(req, res) {
  try {
    const data = await service.getFacultyTimetable(req.params.id);
    return res.json({ success: true, message: "Timetable fetched", ...data });
  } catch (err) {
    return handleError(res, err, "Failed to fetch timetable");
  }
}

export async function getInstituteTimetableController(req, res) {
  try {
    const data = await service.getInstituteTimetable({ day: req.query.day, facultyId: req.query.facultyId });
    return res.json({ success: true, message: "Timetable fetched", ...data });
  } catch (err) {
    return handleError(res, err, "Failed to fetch timetable");
  }
}

export async function createFacultyTimetableController(req, res) {
  try {
    const entry = await service.createFacultyTimetable(req.params.id, req.body || {}, getEditor(req));
    return res.status(201).json({ success: true, message: "Class added", entry });
  } catch (err) {
    return handleError(res, err, "Failed to add class");
  }
}

export async function updateFacultyTimetableController(req, res) {
  try {
    const entry = await service.updateFacultyTimetable(req.params.entryId, req.body || {}, getEditor(req));
    return res.json({ success: true, message: "Class updated", entry });
  } catch (err) {
    return handleError(res, err, "Failed to update class");
  }
}

export async function deleteFacultyTimetableController(req, res) {
  try {
    const entry = await service.deleteFacultyTimetable(req.params.entryId, getEditor(req));
    return res.json({ success: true, message: "Class removed", entry });
  } catch (err) {
    return handleError(res, err, "Failed to remove class");
  }
}

// ---------------------------------------------------------------------------
// Attendance / Students / Exams
// ---------------------------------------------------------------------------

export async function getFacultyAttendanceController(req, res) {
  try {
    const data = await service.getFacultyAttendance(req.params.id);
    return res.json({ success: true, message: "Attendance fetched", ...data });
  } catch (err) {
    return handleError(res, err, "Failed to fetch attendance");
  }
}

export async function saveFacultyAttendanceController(req, res) {
  try {
    const entry = await service.saveFacultyAttendance(req.params.id, req.body || {}, getEditor(req));
    return res.json({ success: true, message: "Attendance saved", entry });
  } catch (err) {
    return handleError(res, err, "Failed to save attendance");
  }
}

export async function getFacultyStudentsController(req, res) {
  try {
    const data = await service.getFacultyStudents(req.params.id);
    return res.json({ success: true, message: "Students fetched", ...data });
  } catch (err) {
    return handleError(res, err, "Failed to fetch students");
  }
}

export async function getFacultyExamsController(req, res) {
  try {
    const data = await service.getFacultyExams(req.params.id);
    return res.json({ success: true, ...data });
  } catch (err) {
    return handleError(res, err, "Failed to fetch exams");
  }
}
