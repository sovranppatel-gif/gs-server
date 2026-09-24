import { Router } from "express";
import { requireMasterAdminJwt } from "../../middleware/requireMasterAdminJwt.js";
import { requireStudentJwt } from "../../middleware/requireStudentJwt.js";
import {
  getAttendanceController,
  getAttendanceOverviewController,
  getStudentMyAttendanceController,
  markBulkAttendanceController,
  searchAttendanceController,
  updateAttendanceController,
} from "./attendance.controller.js";

const router = Router();

/** Student portal — own attendance (must be before master-admin guard) */
router.get("/mine", requireStudentJwt, getStudentMyAttendanceController);

router.use(requireMasterAdminJwt);

router.get("/overview", getAttendanceOverviewController);
router.get("/", getAttendanceController);
router.get("/search", searchAttendanceController);
router.post("/bulk", markBulkAttendanceController);
router.patch("/:id", updateAttendanceController);

export default router;
