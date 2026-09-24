import mongoose from "mongoose";
import { app } from "../src/index.js";
import { connectMongo } from "../src/db/connectMongo.js";

let mongoConnectionPromise = null;

async function ensureMongoConnection() {
  if (mongoose.connection.readyState === 1) return;

  if (!mongoConnectionPromise) {
    mongoConnectionPromise = connectMongo().catch((error) => {
      mongoConnectionPromise = null;
      throw error;
    });
  }

  await mongoConnectionPromise;
}

export default async function handler(req, res) {
  try {
    await ensureMongoConnection();
    return app(req, res);
  } catch (error) {
    console.error("Vercel MongoDB connection failed:", error?.message || error);
    res.setHeader("Retry-After", "5");
    if (req.url === "/api/health" || req.url?.startsWith("/api/health?")) {
      return res.status(503).json({
        success: false,
        ok: false,
        mongoReady: false,
        readyState: mongoose.connection.readyState,
        message: "Database connection is unavailable. Check the MONGO_URI Vercel environment variable.",
        retryAfter: 5,
      });
    }
    return res.status(503).json({
      success: false,
      message: "Database is temporarily unavailable. Please try again shortly.",
      retryAfter: 5,
    });
  }
}