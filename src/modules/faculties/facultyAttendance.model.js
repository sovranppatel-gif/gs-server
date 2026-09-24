import mongoose from "mongoose";

// Faculty's own HR attendance (check-in/out) — distinct from the student
// per-course/semester Attendance module in ../attendance. Do not merge these:
// the shapes and business meaning are different (staff clock-in vs a class
// register).
export const FACULTY_ATTENDANCE_STATUSES = ["Present", "Absent", "Late", "Leave"];
export const FACULTY_ATTENDANCE_METHODS = ["Manual", "Biometric", "QR", "Online"];

const facultyAttendanceSchema = new mongoose.Schema(
  {
    facultyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Faculty",
      required: true,
      index: true,
    },
    date: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: FACULTY_ATTENDANCE_STATUSES,
      default: "Present",
      index: true,
    },
    checkInTime: { type: String, default: "", trim: true },
    checkOutTime: { type: String, default: "", trim: true },
    method: { type: String, enum: FACULTY_ATTENDANCE_METHODS, default: "Manual" },
    note: { type: String, default: "", trim: true },
    markedBy: { type: String, default: "master-admin", trim: true },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

facultyAttendanceSchema.index({ facultyId: 1, date: 1 }, { unique: true });

export const FacultyAttendance = mongoose.model(
  "FacultyAttendance",
  facultyAttendanceSchema
);
