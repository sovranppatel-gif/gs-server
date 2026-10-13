import mongoose from "mongoose";

/** Only Meta's public GET handshake is independent of database readiness. */
export function isWhatsappWebhookVerificationRequest(req) {
  const requestPath = String(req.originalUrl || req.url || '').split('?')[0];
  return req.method === 'GET' && /^\/api\/whatsapp\/webhook\/?$/.test(requestPath);
}

/**
 * Fail fast when Mongo is down/reconnecting so login doesn't hang
 * on Atlas DNS flaps (ENOTFOUND / ReplicaSetNoPrimary).
 */
export function requireDbReady(req, res, next) {
  if (isWhatsappWebhookVerificationRequest(req)) return next();

  // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  if (mongoose.connection.readyState === 1) {
    return next();
  }

  res.setHeader("Retry-After", "3");
  return res.status(503).json({
    success: false,
    message:
      "Server is connecting to the database. Please wait a few seconds and try again.",
    retryAfter: 3,
  });
}

export function isMongoTransientError(err) {
  if (!err) return false;
  const name = String(err.name || "");
  const msg = String(err.message || "");
  return (
    name === "MongoServerSelectionError" ||
    name === "MongoNetworkError" ||
    name === "MongoTimeoutError" ||
    err.code === "ENOTFOUND" ||
    err.code === "ETIMEOUT" ||
    msg.includes("Server selection timed out") ||
    msg.includes("getaddrinfo") ||
    msg.includes("ECONNREFUSED")
  );
}

export function mongoUnavailableResponse(res, err) {
  console.error("Mongo transient error:", err?.message || err);
  res.setHeader("Retry-After", "3");
  return res.status(503).json({
    success: false,
    message:
      "Database is temporarily unavailable. Please wait a few seconds and try again.",
    retryAfter: 3,
  });
}
