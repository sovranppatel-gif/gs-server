// One-time (but safe to rerun) migration: populates shortNameNormalized /
// registrationNumberNormalized on every University document that predates
// those fields (see universities.model.js). Needed once, here, rather than
// left to run lazily on next edit — the partial unique indexes that protect
// against duplicate universities only see documents where the normalized
// field actually exists, so an un-backfilled seed record would silently sit
// outside the uniqueness check until someone happened to save it again.
import mongoose from "mongoose";
import { connectMongo } from "../db/connectMongo.js";
import { University } from "../modules/universities/universities.model.js";

function normalizeForCompare(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function backfillUniversityNormalized() {
  await connectMongo();

  const docs = await University.find({}).select("shortName registrationNumber").lean();
  let updated = 0;

  for (const doc of docs) {
    await University.updateOne(
      { _id: doc._id },
      {
        $set: {
          shortNameNormalized: normalizeForCompare(doc.shortName),
          registrationNumberNormalized: normalizeForCompare(doc.registrationNumber),
        },
      }
    );
    updated += 1;
  }

  console.log(`Backfilled shortNameNormalized/registrationNumberNormalized on ${updated} universit${updated === 1 ? "y" : "ies"}.`);
  await mongoose.disconnect();
}

backfillUniversityNormalized().catch((err) => {
  console.error("Backfill failed:", err);
  mongoose.disconnect().finally(() => process.exit(1));
});
