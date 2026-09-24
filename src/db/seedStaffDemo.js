import { StaffDepartment } from "../modules/staff/staffDepartment.model.js";
import { StaffDesignation } from "../modules/staff/staffDesignation.model.js";
import { Staff } from "../modules/staff/staff.model.js";
import { reserveNextSequence } from "../lib/sequence.js";

const DEPARTMENTS = [
  { name: "Human Resources", code: "HR", headName: "" },
  { name: "Sales", code: "SALES", headName: "" },
  { name: "Development", code: "DEV", headName: "" },
  { name: "Operations", code: "OPS", headName: "" },
  { name: "Finance", code: "FIN", headName: "" },
];

const DESIGNATIONS_BY_DEPT = {
  HR: [{ name: "HR Executive", level: 1 }, { name: "HR Manager", level: 3 }],
  SALES: [
    { name: "Sales Executive", level: 1 },
    { name: "Business Development Executive", level: 1 },
    { name: "Sales Manager", level: 3 },
  ],
  DEV: [
    { name: "Frontend Developer", level: 2 },
    { name: "Backend Developer", level: 2 },
    { name: "QA Engineer", level: 2 },
    { name: "Technical Lead", level: 4 },
  ],
  OPS: [{ name: "Operations Executive", level: 1 }, { name: "Operations Manager", level: 3 }],
  FIN: [{ name: "Accountant", level: 2 }],
};

// Safe demo people — no real personal data.
const DEMO_STAFF = [
  {
    dept: "DEV",
    designation: "Frontend Developer",
    firstName: "Aisha",
    lastName: "Khan",
    mobile: "9000000001",
    email: "aisha.khan@growskillstech.com",
    joiningDate: "2025-08-01",
  },
  {
    dept: "SALES",
    designation: "Business Development Executive",
    firstName: "Rohan",
    lastName: "Mehta",
    mobile: "9000000002",
    email: "rohan.mehta@growskillstech.com",
    joiningDate: "2025-11-15",
  },
  {
    dept: "HR",
    designation: "HR Executive",
    firstName: "Sneha",
    lastName: "Rao",
    mobile: "9000000003",
    email: "sneha.rao@growskillstech.com",
    joiningDate: "2026-01-10",
  },
];

async function nextEmployeeId() {
  const seq = await reserveNextSequence({
    key: "staff",
    readMax: async () => {
      const [result] = await Staff.aggregate([
        { $match: { employeeId: { $regex: "^GST-EMP-[0-9]+$" } } },
        { $project: { seq: { $convert: { input: { $substrCP: ["$employeeId", 8, 20] }, to: "int", onError: 0, onNull: 0 } } } },
        { $group: { _id: null, maxSeq: { $max: "$seq" } } },
      ]);
      return result?.maxSeq || 0;
    },
  });
  return `GST-EMP-${String(seq).padStart(4, "0")}`;
}

export async function seedStaffDemo() {
  const existingStaff = await Staff.countDocuments({ softDelete: false });
  if (existingStaff > 0) return;

  const deptByCode = new Map();
  for (const d of DEPARTMENTS) {
    const doc = await StaffDepartment.findOneAndUpdate(
      { normalizedName: d.name.toLowerCase() },
      { ...d, normalizedName: d.name.toLowerCase(), status: "Active", softDelete: false, createdBy: "system-seed", updatedBy: "system-seed" },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    deptByCode.set(d.code, doc);
  }

  const designationByName = new Map();
  for (const [code, list] of Object.entries(DESIGNATIONS_BY_DEPT)) {
    const dept = deptByCode.get(code);
    for (const desig of list) {
      const doc = await StaffDesignation.findOneAndUpdate(
        { departmentId: dept._id, normalizedName: desig.name.toLowerCase() },
        {
          name: desig.name,
          level: desig.level,
          departmentId: dept._id,
          departmentName: dept.name,
          normalizedName: desig.name.toLowerCase(),
          status: "Active",
          softDelete: false,
          createdBy: "system-seed",
          updatedBy: "system-seed",
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      designationByName.set(`${code}:${desig.name}`, doc);
    }
  }

  for (const s of DEMO_STAFF) {
    const dept = deptByCode.get(s.dept);
    const designation = designationByName.get(`${s.dept}:${s.designation}`);
    const employeeId = await nextEmployeeId();
    await Staff.create({
      employeeId,
      personalDetails: {
        firstName: s.firstName,
        lastName: s.lastName,
        fullName: `${s.firstName} ${s.lastName}`,
        personalMobile: s.mobile,
        officialEmail: s.email,
        gender: "Other",
      },
      employmentDetails: {
        departmentId: dept._id,
        departmentName: dept.name,
        designationId: designation._id,
        designationName: designation.name,
        joiningDate: new Date(s.joiningDate),
        employmentType: "Full Time",
        workMode: "Office",
      },
      employmentHistory: [
        {
          type: "Joining",
          description: `Joined as ${designation.name} in ${dept.name}`,
          date: new Date(s.joiningDate),
          actor: "system-seed",
        },
      ],
      status: "Active",
      createdBy: "system-seed",
      updatedBy: "system-seed",
    });
  }

  console.log(`Seeded staff demo data: ${DEPARTMENTS.length} departments, ${DEMO_STAFF.length} staff`);
}
