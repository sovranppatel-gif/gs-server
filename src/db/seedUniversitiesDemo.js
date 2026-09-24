import { University } from "../modules/universities/universities.model.js";

export const defaultUniversities = [
  {
    name: "Makhanlal Chaturvedi National University of Journalism and Communication",
    shortName: "MCU",
    universityCode: "MCU-BPL",
    registrationNumber: "REG-MCU-2026-001",
    affiliationNumber: "AFF-MCU-117",
    city: "Bhopal",
    state: "Madhya Pradesh",
    contactPerson: "University Coordinator",
    contactPhone: "0755-4902230",
    contactEmail: "coordination@mcu.ac.in",
    website: "https://www.mcu.ac.in",
    status: "Active",
    remarks: "Used for journalism, computer applications and allied admissions.",
    createdBy: "system-seed",
    updatedBy: "system-seed",
    softDelete: false,
  },
  {
    name: "Rani Durgavati Vishwavidyalaya",
    shortName: "RDVV",
    universityCode: "RDVV-JBP",
    registrationNumber: "REG-RDVV-2026-014",
    affiliationNumber: "AFF-RDVV-204",
    city: "Jabalpur",
    state: "Madhya Pradesh",
    contactPerson: "Affiliation Desk",
    contactPhone: "0761-2600567",
    contactEmail: "affiliation@rdunijbpin.org",
    website: "https://www.rdunijbpin.org",
    status: "Active",
    remarks: "Primary university for UG and PG university-linked courses.",
    createdBy: "system-seed",
    updatedBy: "system-seed",
    softDelete: false,
  },
  {
    name: "Indira Gandhi National Open University",
    shortName: "IGNOU",
    universityCode: "IGNOU-DEL",
    registrationNumber: "REG-IGNOU-2026-022",
    affiliationNumber: "AFF-IGNOU-RC",
    city: "New Delhi",
    state: "Delhi",
    contactPerson: "Regional Center Support",
    contactPhone: "011-29572514",
    contactEmail: "support@ignou.ac.in",
    website: "https://www.ignou.ac.in",
    status: "Active",
    remarks: "Distance learning and open university admissions partner.",
    createdBy: "system-seed",
    updatedBy: "system-seed",
    softDelete: false,
  },
];

export async function seedUniversitiesDemo() {
  const existing = await University.countDocuments({ softDelete: false });
  if (existing > 0) return;

  await University.insertMany(defaultUniversities);
  console.log("Seeded demo universities (MCU, RDVV, IGNOU)");
}
