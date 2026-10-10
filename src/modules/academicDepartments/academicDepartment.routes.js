import { Router } from "express";
import { requireMasterAdminJwt } from "../../middleware/requireMasterAdminJwt.js";
import {
  listDepartmentsController,
  listDepartmentOptionsController,
  getDepartmentStatsController,
  getDepartmentController,
  createDepartmentController,
  updateDepartmentController,
  setDepartmentStatusController,
  setDepartmentHodController,
  deleteDepartmentController,
  listDepartmentFacultyController,
  listDepartmentCoursesController,
  listDepartmentStudentsController,
} from "./academicDepartment.controller.js";

const router = Router();

// Single Master Admin role today (no central RBAC) — same guard as every
// other ERP module.
router.use(requireMasterAdminJwt);

// Static paths ahead of /:id so "stats"/"options" are never read as an id
router.get("/stats", getDepartmentStatsController);
router.get("/options", listDepartmentOptionsController);

router.get("/", listDepartmentsController);
router.post("/", createDepartmentController);

router.get("/:id/faculty", listDepartmentFacultyController);
router.get("/:id/courses", listDepartmentCoursesController);
router.get("/:id/students", listDepartmentStudentsController);
router.patch("/:id/status", setDepartmentStatusController);
router.patch("/:id/hod", setDepartmentHodController);

router.get("/:id", getDepartmentController);
router.put("/:id", updateDepartmentController);
router.delete("/:id", deleteDepartmentController);

export default router;
