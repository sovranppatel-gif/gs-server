import mongoose from "mongoose";
import {
  listAttendance,
  markBulkAttendance,
  searchAttendance,
  updateAttendance,
  getAttendanceOverview,
  getStudentMyAttendance,
} from "./attendance.service.js";

function getEditor(req) {
  return req.masterAdmin?.email || "master-admin";
}

export async function getStudentMyAttendanceController(req, res) {
  try {
    const email = String(req.student?.email || "")
      .toLowerCase()
      .trim();
    if (!email) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid student session" });
    }

    let year = req.query.year;
    let month = req.query.month;

    // Allow ?month=2026-07
    const monthParam = String(req.query.month || "").trim();
    if (/^\d{4}-\d{2}$/.test(monthParam)) {
      const [ys, ms] = monthParam.split("-");
      year = ys;
      month = ms;
    }

    const data = await getStudentMyAttendance({
      email,
      year,
      month,
    });

    return res.json({
      success: true,
      message: data.meta?.hasData
        ? "Attendance fetched"
        : "No attendance records yet",
      stats: data.stats,
      calendar: data.calendar,
      trend: data.trend,
      subjects: data.subjects,
      months: data.months,
      rows: data.rows,
      meta: data.meta,
    });
  } catch (err) {
    console.error("student attendance mine error:", err);
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      message: err.message || "Failed to fetch attendance",
    });
  }
}

export async function getAttendanceOverviewController(req, res) {
  try {
    const data = await getAttendanceOverview({
      date: req.query.date || "",
    });
    return res.json({
      success: true,
      message: "Attendance overview fetched",
      stats: data.stats,
      meta: data.meta,
    });
  } catch (err) {
    console.error("attendance overview error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch attendance overview",
    });
  }
}

export async function getAttendanceController(req, res) {
  try {
    const data = await listAttendance({
      universityId: req.query.universityId || "",
      courseId: req.query.courseId || "",
      semester: req.query.semester || "",
      date: req.query.date || "",
      search: req.query.search || "",
      status: req.query.status || "",
    });
    return res.json({
      success: true,
      message: data.meta?.requiresFilters
        ? data.meta.message || "Select filters to load attendance"
        : "Attendance fetched",
      rows: data.rows,
      stats: data.stats,
      meta: data.meta,
    });
  } catch (err) {
    console.error("attendance list error:", err);
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      message: err.message || "Failed to fetch attendance",
    });
  }
}

export async function searchAttendanceController(req, res) {
  try {
    const data = await searchAttendance({
      universityId: req.query.universityId || "",
      courseId: req.query.courseId || "",
      semester: req.query.semester || "",
      date: req.query.date || "",
      search: req.query.search || req.query.q || "",
      limit: req.query.limit || 50,
    });
    return res.json({
      success: true,
      message: "Attendance search results",
      rows: data.rows,
      stats: data.stats,
      meta: data.meta,
    });
  } catch (err) {
    console.error("attendance search error:", err);
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      message: err.message || "Failed to search attendance",
    });
  }
}

export async function markBulkAttendanceController(req, res) {
  try {
    const data = await markBulkAttendance(req.body || {}, getEditor(req));
    return res.json({
      success: true,
      message: `Marked attendance for ${data.marked} student(s)`,
      marked: data.marked,
      rows: data.rows,
      stats: data.stats,
      meta: data.meta,
    });
  } catch (err) {
    console.error("attendance bulk mark error:", err);
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      message: err.message || "Failed to mark attendance",
    });
  }
}

export async function updateAttendanceController(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res
        .status(400)
        .json({ success: false, message: "Attendance id is required" });
    }
    if (
      !mongoose.Types.ObjectId.isValid(id) &&
      !/^ATT-/i.test(id)
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid attendance id" });
    }
    const entry = await updateAttendance(id, req.body || {}, getEditor(req));
    return res.json({
      success: true,
      message: "Attendance updated",
      entry,
    });
  } catch (err) {
    console.error("attendance update error:", err);
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      message: err.message || "Failed to update attendance",
    });
  }
}
