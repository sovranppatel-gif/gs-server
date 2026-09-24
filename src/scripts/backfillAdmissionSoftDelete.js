// One-time (safe to rerun) migration: populates softDelete/updatedBy on every
// Admission document that predates those fields (see models/Admission.js).
// Needed so the new default list query — { softDelete: false } — behaves
// identically to "every admission that existed before this change" rather
// than accidentally hiding pre-existing records that have neither field set.
import mongoose from "mongoose";
import { connectMongo } from "../db/connectMongo.js";
import { Admission } from "../models/Admission.js";

async function backfillAdmissionSoftDelete() {
  await connectMongo();

  const docs = await Admission.find({ softDelete: { $exists: false } }).select("createdBy").lean();
  let updated = 0;

  for (const doc of docs) {
    await Admission.updateOne(
      { _id: doc._id },
      { $set: { softDelete: false, updatedBy: doc.createdBy || "" } }
    );
    updated += 1;
  }

  console.log(`Backfilled softDelete/updatedBy on ${updated} admission(s).`);
  await mongoose.disconnect();
}

backfillAdmissionSoftDelete().catch((err) => {
  console.error("Backfill failed:", err);
  mongoose.disconnect().finally(() => process.exit(1));
});
