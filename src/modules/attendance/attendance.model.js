import mongoose from "mongoose";

export const ATTENDANCE_STATUSES = [
  "Present",
  "Absent",
  "Late",
  "Leave",
  "Holiday",
];

export const ATTENDANCE_METHODS = [
  "Manual",
  "Biometric",
  "QR",
  "Online",
];

const attendanceSchema = new mongoose.Schema(
  {
    attendanceId: { type: String, required: true, unique: true, trim: true },
    admissionId: { type: String, required: true, trim: true, index: true },
    admissionMongoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admission",
      required: true,
      index: true,
    },
    student: { type: String, required: true, trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    phone: { type: String, default: "", trim: true },
    universityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "University",
      required: true,
      index: true,
    },
    universityName: { type: String, default: "", trim: true },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
      required: true,
      index: true,
    },
    courseName: { type: String, default: "", trim: true },
    courseCode: { type: String, default: "", trim: true },
    semester: { type: Number, required: true, min: 1, index: true },
    semesterTitle: { type: String, default: "", trim: true },
    date: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ATTENDANCE_STATUSES,
      default: "Present",
      index: true,
    },
    method: {
      type: String,
      enum: ATTENDANCE_METHODS,
      default: "Manual",
    },
    note: { type: String, default: "", trim: true },
    markedBy: { type: String, default: "master-admin", trim: true },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

attendanceSchema.index(
  { admissionMongoId: 1, courseId: 1, semester: 1, date: 1 },
  { unique: true }
);
attendanceSchema.index({ universityId: 1, courseId: 1, semester: 1, date: 1 });
attendanceSchema.index({ student: "text", email: "text", admissionId: "text" });

export const Attendance = mongoose.model("Attendance", attendanceSchema);
