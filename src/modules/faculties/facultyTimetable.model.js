import mongoose from "mongoose";

export const TIMETABLE_DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
export const TIMETABLE_STATUSES = ["Active", "Inactive"];

const facultyTimetableSchema = new mongoose.Schema(
  {
    facultyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Faculty",
      required: true,
      index: true,
    },
    facultyName: { type: String, default: "", trim: true },
    universityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "University",
      default: null,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
      default: null,
      index: true,
    },
    courseName: { type: String, default: "", trim: true },
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      required: true,
      index: true,
    },
    batchName: { type: String, default: "", trim: true },
    semester: { type: Number, default: null, min: 1 },
    subjectName: { type: String, required: true, trim: true },
    subjectCode: { type: String, default: "", trim: true },
    day: { type: String, enum: TIMETABLE_DAYS, required: true, index: true },
    startTime: { type: String, required: true, trim: true }, // "HH:MM", 24h
    endTime: { type: String, required: true, trim: true },
    room: { type: String, default: "", trim: true },
    status: { type: String, enum: TIMETABLE_STATUSES, default: "Active", index: true },
    createdBy: { type: String, default: "master-admin", trim: true },
    updatedBy: { type: String, default: "master-admin", trim: true },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

facultyTimetableSchema.index({ facultyId: 1, day: 1, status: 1 });
facultyTimetableSchema.index({ batchId: 1, day: 1 });

export const FacultyTimetable = mongoose.model(
  "FacultyTimetable",
  facultyTimetableSchema
);
