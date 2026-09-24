import { Router } from "express";
import { requireMasterAdminJwt } from "../../middleware/requireMasterAdminJwt.js";
import { staffPhotoUpload } from "./staff.upload.js";
import {
  getStaffListController,
  getStaffStatsController,
  getStaffMetaController,
  getStaffController,
  createStaffController,
  updateStaffController,
  updateStaffStatusController,
  archiveStaffController,
  restoreStaffController,
  getStaffDepartmentsController,
  createStaffDepartmentController,
  updateStaffDepartmentController,
  setStaffDepartmentStatusController,
  archiveStaffDepartmentController,
  getStaffDesignationsController,
  createStaffDesignationController,
  updateStaffDesignationController,
  setStaffDesignationStatusController,
  archiveStaffDesignationController,
} from "./staff.controller.js";

const router = Router();

router.use(requireMasterAdminJwt);

router.get("/stats", getStaffStatsController);
router.get("/meta", getStaffMetaController);

router.post("/upload-photo", staffPhotoUpload.single("file"), (req, res) => {
  if (!req.file?.filename) {
    return res.status(400).json({ success: false, message: "No file uploaded" });
  }
  return res.json({
    success: true,
    message: "Photo uploaded",
    data: { url: `/uploads/staff/${req.file.filename}` },
  });
});

// Departments (mounted ahead of /:id so "departments" is never read as an id)
router.get("/departments", getStaffDepartmentsController);
router.post("/departments", createStaffDepartmentController);
router.put("/departments/:id", updateStaffDepartmentController);
router.patch("/departments/:id/status", setStaffDepartmentStatusController);
router.delete("/departments/:id", archiveStaffDepartmentController);

// Designations
router.get("/designations", getStaffDesignationsController);
router.post("/designations", createStaffDesignationController);
router.put("/designations/:id", updateStaffDesignationController);
router.patch("/designations/:id/status", setStaffDesignationStatusController);
router.delete("/designations/:id", archiveStaffDesignationController);

router.get("/", getStaffListController);
router.post("/", createStaffController);

router.patch("/:id/status", updateStaffStatusController);
router.patch("/:id/restore", restoreStaffController);
router.get("/:id", getStaffController);
router.put("/:id", updateStaffController);
router.patch("/:id", updateStaffController);
router.delete("/:id", archiveStaffController);

// Multer errors (e.g. file too large) land here instead of the generic 500 handler.
router.use((err, _req, res, next) => {
  if (!err) return next();
  const message = err.message || "Upload failed";
  const isUploadError = err.name === "MulterError" || /image|photo|file/i.test(message);
  if (isUploadError) return res.status(400).json({ success: false, message });
  return next(err);
});

export default router;
