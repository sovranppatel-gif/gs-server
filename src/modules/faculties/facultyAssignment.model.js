import mongoose from "mongoose";

export const ASSIGNMENT_STATUSES = ["Active", "Inactive"];

const facultyAssignmentSchema = new mongoose.Schema(
  {
    facultyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Faculty",
      required: true,
      index: true,
    },
    universityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "University",
      default: null,
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
    semester: { type: Number, default: null, min: 1 },
    subjectName: { type: String, required: true, trim: true },
    subjectCode: { type: String, default: "", trim: true },
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      default: null,
      index: true,
    },
    batchName: { type: String, default: "", trim: true },
    academicYear: { type: String, default: "", trim: true },
    status: { type: String, enum: ASSIGNMENT_STATUSES, default: "Active", index: true },
    createdBy: { type: String, default: "master-admin", trim: true },
    updatedBy: { type: String, default: "master-admin", trim: true },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

facultyAssignmentSchema.index({ facultyId: 1, status: 1 });
facultyAssignmentSchema.index({ facultyId: 1, subjectName: 1, batchId: 1 });
facultyAssignmentSchema.index({ courseId: 1, status: 1 });

export const FacultyAssignment = mongoose.model(
  "FacultyAssignment",
  facultyAssignmentSchema
);
