import { Counter } from "../models/Counter.js";

export async function reserveNextSequence({ key, readMax, session = null }) {
  const maxValue = Math.max(0, Number(await readMax()) || 0);
  const options = {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
    ...(session ? { session } : {}),
  };

  try {
    await Counter.findOneAndUpdate(
      { key },
      { $max: { seq: maxValue } },
      options
    );
  } catch (err) {
    if (err?.code !== 11000) throw err;
    await Counter.findOneAndUpdate(
      { key },
      { $max: { seq: maxValue } },
      { new: true, ...(session ? { session } : {}) }
    );
  }

  const next = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, ...(session ? { session } : {}) }
  ).lean();

  if (!next) throw new Error(`Unable to reserve sequence: ${key}`);
  return next.seq;
}