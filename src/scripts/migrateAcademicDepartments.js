// Academic Departments migration (safe to rerun — idempotent).
//
//   npm run migrate:academic-departments            → dry run, report only
//   npm run migrate:academic-departments -- --apply → write changes
//
// What it does:
//   1. Reads the legacy free-text Faculty.employmentDetails.department values
//      of faculty that are not yet linked (employmentDetails.departmentId unset).
//   2. For each distinct value (compared trimmed, case/space-insensitive) it
//      reuses the AcademicDepartment with the same normalized name, or creates
//      one. Nothing is fuzzy-matched: "CS" and "Computer Science" stay separate
//      are listed under "possibleDuplicates"; the shorter/abbreviated one is
//      not created and its faculty stay unlinked for a human to resolve.
//   3. Sets Faculty.employmentDetails.departmentId for exact matches only.
//      The legacy `department` string is left untouched.
//   4. Courses have no legacy department text, so they are never guessed —
//      unlinked courses are reported for assignment from the Courses page.
//   5. Validates existing references (dangling ids, invalid HODs) and reports.
//
// Before writing, the affected faculty fields are backed up to
// ./backups/academic-departments-<timestamp>.json. Nothing is deleted.
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { connectMongo } from "../db/connectMongo.js";
import { Faculty } from "../modules/faculties/faculty.model.js";
import { Course } from "../modules/courses/courses.model.js";
import { AcademicDepartment } from "../modules/academicDepartments/academicDepartment.model.js";
import { cleanName, normalizeDepartmentName } from "../modules/academicDepartments/academicDepartment.validation.js";

const APPLY = process.argv.includes("--apply");
const EDITOR = "migration:academic-departments";

function baseCode(name) {
  const words = cleanName(name).replace(/[^A-Za-z0-9 ]+/g, " ").split(" ").filter(Boolean);
  if (!words.length) return "DEPT";
  if (words.length === 1) return words[0].slice(0, 6).toUpperCase();
  return words.map((w) => w[0]).join("").slice(0, 8).toUpperCase();
}

async function uniqueCode(name, taken) {
  const base = baseCode(name);
  let code = base;
  for (let i = 2; taken.has(code); i += 1) code = `${base}-${i}`;
  taken.add(code);
  return code;
}

async function migrate() {
  await connectMongo();
  console.log(APPLY ? "Mode: APPLY (changes will be written)" : "Mode: DRY RUN (no changes) — pass --apply to write");

  const report = {
    mode: APPLY ? "apply" : "dry-run",
    departmentsExisting: 0,
    departmentsCreated: [],
    facultyMapped: 0,
    facultyAlreadyLinked: 0,
    facultyWithoutDepartmentText: 0,
    facultyUnmapped: [],
    possibleDuplicates: [],
    coursesLinked: 0,
    coursesUnlinked: [],
    danglingFacultyRefs: [],
    danglingCourseRefs: [],
    invalidHods: [],
  };

  // --- Existing departments -------------------------------------------------
  const existing = await AcademicDepartment.find({ softDelete: false }).select("+normalizedName name code").lean();
  report.departmentsExisting = existing.length;
  const deptByKey = new Map(existing.map((d) => [d.normalizedName || normalizeDepartmentName(d.name), d]));
  const takenCodes = new Set(existing.map((d) => d.code));

  // --- Legacy faculty department text --------------------------------------
  const unlinked = await Faculty.find({ "employmentDetails.departmentId": { $not: { $type: "objectId" } } })
    .select("facultyId softDelete employmentDetails.department employmentDetails.departmentId")
    .lean();
  report.facultyAlreadyLinked = await Faculty.countDocuments({ "employmentDetails.departmentId": { $type: "objectId" } });

  const groups = new Map(); // key → { label, faculty: [] }
  for (const f of unlinked) {
    const label = cleanName(f.employmentDetails?.department);
    if (!label) {
      report.facultyWithoutDepartmentText += 1;
      continue;
    }
    const key = normalizeDepartmentName(label);
    if (!groups.has(key)) groups.set(key, { label, faculty: [] });
    groups.get(key).faculty.push(f);
  }

  // Near-duplicates — one name contains the other, or one is the other's
  // initials ("cs" ↔ "computer science"). The shorter name is NOT auto-created
  // or mapped; its faculty stay unlinked for a human to resolve.
  const initials = (k) => k.split(" ").filter(Boolean).map((w) => w[0]).join("");
  const keys = [...new Set([...groups.keys(), ...deptByKey.keys()])];
  const suspect = new Set();
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const [a, b] = [keys[i], keys[j]];
      const related =
        a.includes(b) || b.includes(a) || (a.includes(" ") && initials(a) === b) || (b.includes(" ") && initials(b) === a);
      if (!related) continue;
      report.possibleDuplicates.push([a, b]);
      const shorter = a.length <= b.length ? a : b;
      if (!deptByKey.has(shorter)) suspect.add(shorter);
    }
  }

  if (APPLY && unlinked.length) {
    const dir = path.join(process.cwd(), "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `academic-departments-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify(unlinked, null, 2));
    console.log(`Backup of ${unlinked.length} faculty department field(s) → ${file}`);
  }

  for (const [key, group] of groups) {
    if (suspect.has(key)) {
      for (const f of group.faculty) {
        report.facultyUnmapped.push({ facultyId: f.facultyId, department: group.label, reason: "possible duplicate — review manually" });
      }
      continue;
    }
    let dept = deptByKey.get(key);
    if (!dept) {
      const code = await uniqueCode(group.label, takenCodes);
      const planned = { name: group.label, code, faculty: group.faculty.length };
      report.departmentsCreated.push(planned);
      if (APPLY) {
        dept = await AcademicDepartment.create({
          name: group.label,
          code,
          normalizedName: key,
          status: "Active",
          description: "Created by migration from existing faculty department names.",
          createdBy: EDITOR,
          updatedBy: EDITOR,
        });
        deptByKey.set(key, dept);
      }
    }
    if (!dept) {
      report.facultyMapped += group.faculty.length; // would be mapped on --apply
      continue;
    }
    if (APPLY) {
      // Only rows still unlinked — safe to rerun.
      const res = await Faculty.updateMany(
        {
          _id: { $in: group.faculty.map((f) => f._id) },
          "employmentDetails.departmentId": { $not: { $type: "objectId" } },
        },
        { $set: { "employmentDetails.departmentId": dept._id } }
      );
      report.facultyMapped += res.modifiedCount;
    } else {
      report.facultyMapped += group.faculty.length;
    }
  }

  // --- Reference validation -------------------------------------------------
  const liveDeptIds = new Set(
    (await AcademicDepartment.find({ softDelete: false }).select("_id").lean()).map((d) => String(d._id))
  );

  const linkedFaculty = await Faculty.find({ "employmentDetails.departmentId": { $type: "objectId" } })
    .select("facultyId employmentDetails.departmentId status softDelete")
    .lean();
  for (const f of linkedFaculty) {
    if (!liveDeptIds.has(String(f.employmentDetails.departmentId))) {
      report.danglingFacultyRefs.push({ facultyId: f.facultyId, departmentId: String(f.employmentDetails.departmentId) });
    }
  }

  const courses = await Course.find({ softDelete: false }).select("name code departmentId").lean();
  for (const c of courses) {
    if (!c.departmentId) report.coursesUnlinked.push({ _id: String(c._id), name: c.name, code: c.code || "" });
    else if (!liveDeptIds.has(String(c.departmentId))) {
      report.danglingCourseRefs.push({ _id: String(c._id), name: c.name, departmentId: String(c.departmentId) });
    } else report.coursesLinked += 1;
  }

  const withHod = await AcademicDepartment.find({ softDelete: false, hod: { $type: "objectId" } }).select("name hod").lean();
  for (const d of withHod) {
    const hod = await Faculty.findOne({ _id: d.hod }).select("facultyId status softDelete employmentDetails.departmentId").lean();
    const valid = hod && !hod.softDelete && hod.status === "Active" && String(hod.employmentDetails?.departmentId) === String(d._id);
    if (!valid) report.invalidHods.push({ department: d.name, hod: String(d.hod) });
  }


  console.log(JSON.stringify(report, null, 2));
  console.log(
    `\nSummary: ${report.departmentsCreated.length} department(s) ${APPLY ? "created" : "to create"}, ` +
      `${report.facultyMapped} faculty ${APPLY ? "mapped" : "to map"}, ` +
      `${report.facultyUnmapped.length} faculty left unmapped for manual review, ` +
      `${report.facultyWithoutDepartmentText} faculty without department text, ` +
      `${report.coursesUnlinked.length} course(s) still need a department (assign from Courses page).`
  );
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error("Academic departments migration failed:", err);
  mongoose.disconnect().finally(() => process.exit(1));
});
