import { Course } from "../modules/courses/courses.model.js";
import { University } from "../modules/universities/universities.model.js";

function sem(number, durationMonths, subjects, description = "") {
  return {
    number,
    title: `Semester ${number}`,
    durationMonths,
    description,
    subjects,
  };
}

function subject(name, code, theoryHours = 40, practicalHours = 40, credits = 4) {
  return { name, code, theoryHours, practicalHours, credits };
}

/** Full detail templates keyed by course code / name */
const COURSE_DETAILS = {
  "MCU-PGDCA": {
    category: "PG Diploma",
    durationMonths: 12,
    durationLabel: "1 year (2 semesters)",
    semesterCount: 2,
    fees: { total: "₹18,000", registration: "₹1,500", exam: "₹1,000", installmentAllowed: true },
    eligibility: "Graduate in any discipline",
    mode: "Offline",
    description:
      "Post Graduate Diploma in Computer Applications — MCU affiliated. Two-semester program covering programming, databases, web and software fundamentals.",
    highlights: ["MCU affiliated", "2 semesters", "Practical lab focus", "Project in Sem 2"],
    semesters: [
      sem(1, 6, [
        subject("Fundamentals of Computers", "PGDCA-101", 40, 20, 4),
        subject("Programming with C / C++", "PGDCA-102", 40, 40, 5),
        subject("Office Automation & Soft Skills", "PGDCA-103", 30, 40, 4),
        subject("Internet & Web Basics", "PGDCA-104", 30, 40, 4),
      ], "Foundation semester — computers, programming and office tools."),
      sem(2, 6, [
        subject("Database Management Systems", "PGDCA-201", 40, 40, 5),
        subject("Web Development (HTML/CSS/JS)", "PGDCA-202", 30, 50, 5),
        subject("Software Engineering Basics", "PGDCA-203", 40, 20, 4),
        subject("Project Work / Viva", "PGDCA-204", 10, 60, 6),
      ], "Advanced semester — databases, web and final project."),
    ],
  },
  "MCU-DCA": {
    category: "Diploma",
    durationMonths: 12,
    durationLabel: "1 year (2 semesters)",
    semesterCount: 2,
    fees: { total: "₹12,000", registration: "₹1,000", exam: "₹800", installmentAllowed: true },
    eligibility: "10+2 or equivalent",
    mode: "Offline",
    description:
      "Diploma in Computer Applications — MCU affiliated. Two-semester diploma for foundational computer and office skills.",
    highlights: ["MCU affiliated", "2 semesters", "Beginner friendly", "Job-oriented labs"],
    semesters: [
      sem(1, 6, [
        subject("Computer Fundamentals", "DCA-101", 40, 20, 4),
        subject("MS Office Suite", "DCA-102", 20, 50, 4),
        subject("Operating Systems Basics", "DCA-103", 30, 30, 3),
        subject("Internet Applications", "DCA-104", 20, 40, 3),
      ], "Basics of computers, OS and office productivity."),
      sem(2, 6, [
        subject("Programming Basics", "DCA-201", 30, 40, 4),
        subject("Database & Spreadsheets", "DCA-202", 30, 40, 4),
        subject("Web Designing Intro", "DCA-203", 20, 50, 4),
        subject("Mini Project", "DCA-204", 10, 50, 4),
      ], "Programming intro, databases and mini project."),
    ],
  },
  "MCU-BCA": {
    category: "Degree",
    durationMonths: 36,
    durationLabel: "3 years (support / bridge)",
    semesterCount: 2,
    fees: { total: "As per university", registration: "", exam: "", installmentAllowed: true },
    eligibility: "As per MCU BCA norms",
    mode: "Hybrid",
    description: "BCA Support track mapped under MCU for coaching / bridge classes.",
    highlights: ["MCU support", "Bridge modules"],
    semesters: [
      sem(1, 6, [
        subject("Programming Support Lab", "BCA-S01", 20, 60, 4),
        subject("Mathematics Bridge", "BCA-S02", 40, 20, 3),
      ]),
      sem(2, 6, [
        subject("Project Mentorship", "BCA-S03", 10, 60, 4),
        subject("Exam Preparation", "BCA-S04", 40, 20, 3),
      ]),
    ],
  },
  "RDVV-BA": {
    category: "Degree",
    durationMonths: 36,
    durationLabel: "3 years",
    semesterCount: 6,
    fees: { total: "As per university", registration: "", exam: "", installmentAllowed: true },
    eligibility: "10+2",
    mode: "Offline",
    description: "Bachelor of Arts — RDVV affiliated pathway.",
    highlights: ["RDVV affiliated", "6 semesters"],
    semesters: [],
  },
  "RDVV-BCOM": {
    category: "Degree",
    durationMonths: 36,
    durationLabel: "3 years",
    semesterCount: 6,
    fees: { total: "As per university", registration: "", exam: "", installmentAllowed: true },
    eligibility: "10+2 Commerce / any",
    mode: "Offline",
    description: "Bachelor of Commerce — RDVV affiliated pathway.",
    highlights: ["RDVV affiliated", "6 semesters"],
    semesters: [],
  },
  "RDVV-MA": {
    category: "Degree",
    durationMonths: 24,
    durationLabel: "2 years",
    semesterCount: 4,
    fees: { total: "As per university", registration: "", exam: "", installmentAllowed: true },
    eligibility: "Graduate",
    mode: "Offline",
    description: "Master of Arts — RDVV affiliated pathway.",
    highlights: ["RDVV affiliated", "4 semesters"],
    semesters: [],
  },
  "IGNOU-BCA": {
    category: "Degree",
    durationMonths: 36,
    durationLabel: "3 years",
    semesterCount: 6,
    fees: { total: "As per IGNOU", registration: "", exam: "", installmentAllowed: true },
    eligibility: "10+2 with Mathematics",
    mode: "Hybrid",
    description: "Bachelor of Computer Applications — IGNOU.",
    highlights: ["IGNOU", "Distance + counseling"],
    semesters: [],
  },
  "IGNOU-MCA": {
    category: "Degree",
    durationMonths: 24,
    durationLabel: "2 years",
    semesterCount: 4,
    fees: { total: "As per IGNOU", registration: "", exam: "", installmentAllowed: true },
    eligibility: "Graduate with maths / BCA",
    mode: "Hybrid",
    description: "Master of Computer Applications — IGNOU.",
    highlights: ["IGNOU", "4 semesters"],
    semesters: [],
  },
  "IGNOU-CERT": {
    category: "Certificate",
    durationMonths: 6,
    durationLabel: "6 months",
    semesterCount: 1,
    fees: { total: "As per IGNOU", registration: "", exam: "", installmentAllowed: true },
    eligibility: "10+2",
    mode: "Online",
    description: "IGNOU certificate programs (mapped as a single catalog entry).",
    highlights: ["Short duration", "Certificate"],
    semesters: [
      sem(1, 6, [subject("Certificate Module", "CERT-01", 30, 30, 4)]),
    ],
  },
};

/** Grow Skills Tech institute courses — both 6 months (as currently used in institute) */
const GST_COURSES = [
  {
    name: "Full Stack Web Development",
    code: "GST-FSWD",
    type: "Institute",
    universityName: "Grow Skills Tech",
    universityShortName: "GST",
    category: "Training",
    durationMonths: 6,
    durationLabel: "6 months",
    semesterCount: 2,
    fees: {
      total: "₹89,999",
      registration: "₹5,000",
      exam: "",
      installmentAllowed: true,
    },
    eligibility: "10+2 / Graduate — basic computer knowledge preferred",
    mode: "Hybrid",
    description:
      "Industry training at Grow Skills Tech — MERN stack, APIs, deployment and portfolio projects. Structured as two 3-month blocks.",
    highlights: ["6 months", "MERN stack", "Live projects", "Placement support"],
    status: "Active",
    remarks: "Institute training course — Grow Skills Tech",
    semesters: [
      sem(1, 3, [
        subject("HTML, CSS & Responsive UI", "FSWD-101", 20, 60, 4),
        subject("JavaScript & ES6+", "FSWD-102", 30, 50, 5),
        subject("React.js Fundamentals", "FSWD-103", 30, 50, 5),
        subject("Git & Soft Skills", "FSWD-104", 10, 20, 2),
      ], "Frontend foundation block (3 months)."),
      sem(2, 3, [
        subject("Node.js & Express APIs", "FSWD-201", 30, 50, 5),
        subject("MongoDB & Data Modeling", "FSWD-202", 30, 40, 4),
        subject("Auth, Deployment & DevOps Basics", "FSWD-203", 20, 40, 4),
        subject("Capstone Project", "FSWD-204", 10, 70, 6),
      ], "Backend + project block (3 months)."),
    ],
  },
  {
    name: "Data Science with Python",
    code: "GST-DSPY",
    type: "Institute",
    universityName: "Grow Skills Tech",
    universityShortName: "GST",
    category: "Training",
    durationMonths: 6,
    durationLabel: "6 months",
    semesterCount: 2,
    fees: {
      total: "₹99,999",
      registration: "₹5,000",
      exam: "",
      installmentAllowed: true,
    },
    eligibility: "10+2 / Graduate — interest in maths / analytics",
    mode: "Hybrid",
    description:
      "Grow Skills Tech data science track — Python, analytics, ML basics and a capstone. Two blocks of 3 months each.",
    highlights: ["6 months", "Python", "ML basics", "Capstone"],
    status: "Active",
    remarks: "Institute training course — Grow Skills Tech",
    semesters: [
      sem(1, 3, [
        subject("Python Programming", "DSPY-101", 30, 50, 5),
        subject("NumPy & Pandas", "DSPY-102", 20, 50, 4),
        subject("Data Visualization", "DSPY-103", 20, 40, 4),
        subject("SQL for Analytics", "DSPY-104", 20, 40, 3),
      ], "Python & analytics foundation (3 months)."),
      sem(2, 3, [
        subject("Statistics for DS", "DSPY-201", 40, 20, 4),
        subject("Machine Learning Basics", "DSPY-202", 30, 50, 5),
        subject("ML Project Pipeline", "DSPY-203", 20, 50, 4),
        subject("Capstone Project", "DSPY-204", 10, 70, 6),
      ], "ML + capstone block (3 months)."),
    ],
  },
];

function enrichFromUniversityCourse(uni, offered) {
  const code = String(offered.code || "").toUpperCase();
  const name = String(offered.name || "").trim();
  const details =
    COURSE_DETAILS[code] ||
    COURSE_DETAILS[
      Object.keys(COURSE_DETAILS).find((k) =>
        name && COURSE_DETAILS[k] && k.endsWith(`-${name.toUpperCase().replace(/\s+/g, "")}`)
      )
    ] ||
    null;

  const fallbackSemesters =
    details?.semesters?.length > 0
      ? details.semesters
      : [
          sem(1, 6, [subject(`${name} — Module A`, `${code || "CRS"}-S1`, 30, 30, 4)]),
          sem(2, 6, [subject(`${name} — Module B`, `${code || "CRS"}-S2`, 30, 30, 4)]),
        ];

  return {
    name,
    code,
    type: "University",
    universityId: uni._id,
    universityName: uni.name,
    universityShortName: uni.shortName,
    category: details?.category || "Diploma",
    durationMonths: details?.durationMonths ?? 12,
    durationLabel: details?.durationLabel || "1 year (2 semesters)",
    semesterCount: details?.semesterCount ?? fallbackSemesters.length,
    semesters: details?.semesters?.length ? details.semesters : fallbackSemesters,
    fees: details?.fees || {
      total: "",
      registration: "",
      exam: "",
      installmentAllowed: true,
    },
    eligibility: details?.eligibility || "",
    mode: details?.mode || "Offline",
    description: details?.description || `${name} offered under ${uni.shortName}.`,
    highlights: details?.highlights || [`${uni.shortName} affiliated`],
    status: "Active",
    remarks: `Seeded under ${uni.shortName}`,
    createdBy: "system-seed",
    updatedBy: "system-seed",
    softDelete: false,
  };
}

/** Demo university courses keyed by university shortName (Courses module is source of truth). */
const DEMO_UNIVERSITY_COURSES = {
  MCU: [
    { name: "PGDCA", code: "MCU-PGDCA" },
    { name: "DCA", code: "MCU-DCA" },
    { name: "BCA Support", code: "MCU-BCA" },
  ],
  RDVV: [
    { name: "BA", code: "RDVV-BA" },
    { name: "BCom", code: "RDVV-BCOM" },
    { name: "MA", code: "RDVV-MA" },
  ],
  IGNOU: [
    { name: "BCA", code: "IGNOU-BCA" },
    { name: "MCA", code: "IGNOU-MCA" },
    { name: "Certificate Programs", code: "IGNOU-CERT" },
  ],
};

export async function seedCoursesDemo() {
  const existing = await Course.countDocuments({ softDelete: false });
  if (existing > 0) {
    console.log("Courses already present — skip seed");
    return;
  }

  const universities = await University.find({ softDelete: false }).lean();
  const uniCourses = [];

  for (const uni of universities) {
    const shortName = String(uni.shortName || "").toUpperCase();
    const offered = DEMO_UNIVERSITY_COURSES[shortName] || [];
    for (const course of offered) {
      if (!course?.name) continue;
      uniCourses.push(enrichFromUniversityCourse(uni, course));
    }
  }

  const gstCourses = GST_COURSES.map((c) => ({
    ...c,
    universityId: null,
    createdBy: "system-seed",
    updatedBy: "system-seed",
    softDelete: false,
  }));

  const all = [...uniCourses, ...gstCourses];
  if (!all.length) {
    console.log("No university courses found to seed");
    return;
  }

  await Course.insertMany(all);
  console.log(
    `Seeded ${all.length} courses (${uniCourses.length} university + ${gstCourses.length} GST institute)`
  );
}
