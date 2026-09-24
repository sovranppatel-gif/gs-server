import { Router } from "express";
import bcrypt from "bcryptjs";
import { requireMasterAdminJwt } from "../../middleware/requireMasterAdminJwt.js";
import { requireFacultyJwt } from "../../middleware/requireFacultyJwt.js";
import { signFacultyToken } from "../../lib/jwt.js";
import { facultyPhotoUpload } from "./faculty.upload.js";
import { Faculty } from "./faculty.model.js";
import { getFacultyById } from "./faculty.service.js";
import {
  getFacultiesController,
  getFacultyStatsController,
  getFacultyMetaController,
  getFacultyController,
  createFacultyController,
  updateFacultyController,
  updateFacultyStatusController,
  deleteFacultyController,
  uploadFacultyPhotoController,
  getFacultyAssignmentsController,
  getAllFacultyAssignmentsController,
  createFacultyAssignmentController,
  updateFacultyAssignmentController,
  updateFacultyAssignmentStatusController,
  deleteFacultyAssignmentController,
  getFacultyTimetableController,
  getInstituteTimetableController,
  createFacultyTimetableController,
  updateFacultyTimetableController,
  deleteFacultyTimetableController,
  getFacultyAttendanceController,
  saveFacultyAttendanceController,
  getFacultyStudentsController,
  getFacultyExamsController,
} from "./faculty.controller.js";

const router = Router();

// ---------------------------------------------------------------------------
// Faculty self-service auth — public login, then a JWT-scoped /me. Mirrors
// masterAdminAuth.routes.js / studentAuth.routes.js (bcrypt + constant-time
// dummy-hash compare, same JWT shape).
// ---------------------------------------------------------------------------

const DUMMY_HASH = bcrypt.hashSync(`__never_matches_${Date.now()}_${Math.random()}`, 10);

router.post("/auth/login", async (req, res) => {
  try {
    const identifier = String(req.body?.username || req.body?.email || "").toLowerCase().trim();
    const password = String(req.body?.password || "");

    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: "Username/email and password are required" });
    }

    const user = await Faculty.findOne({
      softDelete: false,
      "accountDetails.loginEnabled": true,
      $or: [{ "accountDetails.username": identifier }, { "personalDetails.email": identifier }],
    }).select("+accountDetails.passwordHash");

    const hashToCompare = user?.accountDetails?.passwordHash || DUMMY_HASH;
    const ok = await bcrypt.compare(password, hashToCompare);

    if (!user || user.status !== "Active" || !ok) {
      return res.status(401).json({ success: false, message: "Invalid username or password" });
    }

    const token = signFacultyToken({
      sub: `faculty:${user._id.toString()}`,
      email: user.personalDetails.email,
      name: user.personalDetails.fullName,
    });

    return res.json({
      success: true,
      token,
      user: {
        id: user._id.toString(),
        facultyId: user.facultyId,
        name: user.personalDetails.fullName,
        email: user.personalDetails.email,
        designation: user.employmentDetails.designation,
        permissions: user.permissions || [],
        role: "faculty",
      },
    });
  } catch (err) {
    console.error("faculty login error:", err);
    return res.status(500).json({ success: false, message: "Login failed" });
  }
});

router.get("/auth/me", requireFacultyJwt, async (req, res) => {
  try {
    const id = String(req.faculty.sub || "").replace(/^faculty:/, "");
    const entry = await getFacultyById(id);
    if (!entry || entry.status !== "Active") {
      return res.status(401).json({ success: false, message: "Account not found" });
    }
    return res.json({ success: true, entry });
  } catch (err) {
    console.error("faculty /auth/me error:", err);
    return res.status(500).json({ success: false, message: "Lookup failed" });
  }
});

// ---------------------------------------------------------------------------
// Master-admin managed CRUD — everything below requires a master-admin JWT.
// ---------------------------------------------------------------------------

router.use(requireMasterAdminJwt);

router.get("/stats/overview", getFacultyStatsController);
router.get("/meta", getFacultyMetaController);
router.get("/assignments", getAllFacultyAssignmentsController);
router.get("/timetable", getInstituteTimetableController);

router.post("/upload-photo", facultyPhotoUpload.single("file"), uploadFacultyPhotoController);

router.put("/assignments/:assignmentId", updateFacultyAssignmentController);
router.patch("/assignments/:assignmentId/status", updateFacultyAssignmentStatusController);
router.delete("/assignments/:assignmentId", deleteFacultyAssignmentController);

router.put("/timetable/:entryId", updateFacultyTimetableController);
router.delete("/timetable/:entryId", deleteFacultyTimetableController);

router.get("/", getFacultiesController);
router.post("/", createFacultyController);

router.get("/:id/assignments", getFacultyAssignmentsController);
router.post("/:id/assignments", createFacultyAssignmentController);

router.get("/:id/timetable", getFacultyTimetableController);
router.post("/:id/timetable", createFacultyTimetableController);

router.get("/:id/attendance", getFacultyAttendanceController);
router.post("/:id/attendance", saveFacultyAttendanceController);

router.get("/:id/students", getFacultyStudentsController);
router.get("/:id/exams", getFacultyExamsController);

router.get("/:id", getFacultyController);
router.put("/:id", updateFacultyController);
router.patch("/:id/status", updateFacultyStatusController);
router.delete("/:id", deleteFacultyController);

// Multer errors (e.g. file too large) land here instead of the generic 500 handler.
router.use((err, _req, res, next) => {
  if (!err) return next();
  const message = err.message || "Upload failed";
  const isUploadError = err.name === "MulterError" || /image|photo|file/i.test(message);
  if (isUploadError) return res.status(400).json({ success: false, message });
  return next(err);
});

export default router;
