import bcrypt from "bcryptjs";
import { Faculty } from "../modules/faculties/faculty.model.js";
import { FacultyAssignment } from "../modules/faculties/facultyAssignment.model.js";
import { FacultyTimetable } from "../modules/faculties/facultyTimetable.model.js";
import { Course } from "../modules/courses/courses.model.js";
import { Batch } from "../modules/batches/batches.model.js";

const FIRST_NAMES = [
  "Aarav", "Priya", "Rohan", "Ananya", "Vikram", "Sneha", "Karan", "Divya",
  "Arjun", "Neha", "Rahul", "Pooja", "Aditya", "Kavita", "Sanjay", "Meera",
  "Nikhil", "Ritu", "Manish", "Shreya", "Deepak", "Anjali", "Suresh", "Isha",
];
const LAST_NAMES = [
  "Sharma", "Verma", "Gupta", "Iyer", "Reddy", "Nair", "Joshi", "Mehta",
  "Kapoor", "Chauhan", "Malhotra", "Bose", "Rao", "Pandey", "Saxena", "Bhatt",
];
const DESIGNATIONS = [
  "Trainer", "Senior Trainer", "Assistant Professor", "Associate Professor",
  "Professor", "Head of Department", "Lab Instructor",
];
const DEPARTMENTS = [
  "Computer Science", "Information Technology", "Electronics", "Management", "Design",
];
const CITIES = [
  ["Jabalpur", "Madhya Pradesh"],
  ["Bhopal", "Madhya Pradesh"],
  ["Indore", "Madhya Pradesh"],
  ["Nagpur", "Maharashtra"],
];

const TIMETABLE_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pick(list, i) {
  return list[i % list.length];
}

function slugEmail(first, last, i) {
  return `${first}.${last}${i}@growskillstech.demo`.toLowerCase();
}

/**
 * Idempotent demo seed: tops up faculty to TARGET_COUNT, each with a couple
 * of assignments (linked to whatever courses/batches already exist) and one
 * timetable slot. Safe to call on every server start — it only adds what's
 * missing and never duplicates.
 */
export async function seedFacultyDemo(targetCount = 24) {
  const existingCount = await Faculty.countDocuments({ createdBy: "system-seed" });
  if (existingCount >= targetCount) return;

  const [courses, batches] = await Promise.all([
    Course.find({ softDelete: false, status: "Active" }).select("name universityId universityName").limit(20).lean(),
    Batch.find({ softDelete: false }).select("name courseId courseName").limit(40).lean(),
  ]);

  const demoPasswordHash = await bcrypt.hash("faculty123", 10);
  const toCreate = targetCount - existingCount;
  let created = 0;

  for (let i = existingCount; i < existingCount + toCreate; i += 1) {
    const first = pick(FIRST_NAMES, i);
    const last = pick(LAST_NAMES, i + 3);
    const fullName = `${first} ${last}`;
    const designation = pick(DESIGNATIONS, i);
    const department = pick(DEPARTMENTS, i + 1);
    const [city, state] = pick(CITIES, i);
    const loginEnabled = i % 3 === 0;
    const status = i % 11 === 0 ? "Inactive" : "Active";

    const latest = await Faculty.findOne({ facultyId: /^FAC-\d+$/ }).sort({ facultyId: -1 }).select("facultyId").lean();
    const seq = latest ? parseInt(String(latest.facultyId).replace("FAC-", ""), 10) + 1 : 1;
    const facultyId = `FAC-${String(seq).padStart(4, "0")}`;

    const faculty = await Faculty.create({
      facultyId,
      personalDetails: {
        fullName,
        gender: i % 2 === 0 ? "Male" : "Female",
        mobile: `9${String(100000000 + i * 137).slice(0, 9)}`,
        email: slugEmail(first, last, i),
        city,
        state,
        address: `${i + 1} MG Road`,
        pincode: "482001",
      },
      employmentDetails: {
        designation,
        department,
        qualification: designation.includes("Professor") ? "Ph.D." : "M.Tech",
        specialization: department,
        experienceYears: 1 + (i % 12),
        joiningDate: new Date(2024, i % 12, (i % 27) + 1),
        employmentType: i % 5 === 0 ? "Part Time" : "Full Time",
      },
      accountDetails: {
        loginEnabled,
        username: loginEnabled ? slugEmail(first, last, i) : "",
        passwordHash: loginEnabled ? demoPasswordHash : "",
      },
      status,
      permissions: loginEnabled ? ["faculty.attendance.mark", "faculty.assignments.manage"] : [],
      createdBy: "system-seed",
      updatedBy: "system-seed",
    });

    // Link one or two assignments when demo courses/batches already exist.
    if (courses.length) {
      const course = pick(courses, i);
      const batch = batches.find((b) => String(b.courseId) === String(course._id)) || null;
      const assignment = await FacultyAssignment.create({
        facultyId: faculty._id,
        universityId: course.universityId || null,
        universityName: course.universityName || "",
        courseId: course._id,
        courseName: course.name,
        semester: 1,
        subjectName: `${course.name} — Core`,
        subjectCode: "",
        batchId: batch?._id || null,
        batchName: batch?.name || "",
        academicYear: "2026–27",
        status: "Active",
        createdBy: "system-seed",
        updatedBy: "system-seed",
      });

      await Faculty.updateOne({ _id: faculty._id }, { $set: { assignedCourses: [course.name] } });

      if (batch) {
        await FacultyTimetable.create({
          facultyId: faculty._id,
          facultyName: fullName,
          universityId: course.universityId || null,
          courseId: course._id,
          courseName: course.name,
          batchId: batch._id,
          batchName: batch.name,
          semester: 1,
          subjectName: assignment.subjectName,
          day: pick(TIMETABLE_DAYS, i),
          startTime: `${9 + (i % 6)}:00`.padStart(5, "0"),
          endTime: `${10 + (i % 6)}:00`.padStart(5, "0"),
          room: `Room ${101 + (i % 8)}`,
          status: "Active",
          createdBy: "system-seed",
          updatedBy: "system-seed",
        });
      }
    }

    created += 1;
  }

  console.log(
    `Seeded ${created} demo faculty (login-enabled demo accounts use password "faculty123" — dev/demo only).`
  );
}
