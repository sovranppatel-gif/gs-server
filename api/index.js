import { initializeWhatsapp } from "../src/modules/whatsapp/services/initialize.service.js";
import { safeError } from '../src/modules/whatsapp/whatsapp.security.js';
import mongoose from "mongoose";
import { app } from "../src/index.js";
import { connectMongo } from "../src/db/connectMongo.js";
import { isWhatsappWebhookVerificationRequest } from '../src/middleware/requireDbReady.js';

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
    // Meta's verification handshake must work even while the DB is unavailable.
    if (isWhatsappWebhookVerificationRequest(req)) return app(req, res);
    await ensureMongoConnection();
    // A diagnostic read must not seed settings/flows on a serverless cold start.
    const settingsRead = req.method === 'GET' && /^\/api\/whatsapp\/settings\/?$/.test(String(req.url || '').split('?')[0]);
    if (req.url?.startsWith('/api/whatsapp') && !settingsRead) await initializeWhatsapp();
    return app(req, res);
  } catch (error) {
    console.error("Vercel MongoDB connection failed:", safeError(error));
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
