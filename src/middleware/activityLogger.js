import { createActivityLog } from "../modules/activityLog/activityLog.service.js";

const SECTION_MAP = [
  { prefix: "/api/hero-left", section: "hero-left" },
  { prefix: "/api/about", section: "about" },
  { prefix: "/api/expertise", section: "expertise" },
  { prefix: "/api/process", section: "process" },
  { prefix: "/api/services", section: "services" },
  { prefix: "/api/case-study", section: "case-study" },
  { prefix: "/api/faq", section: "faq" },
  { prefix: "/api/universities", section: "universities" },
  { prefix: "/api/courses", section: "courses" },
  { prefix: "/api/admissions", section: "admissions" },
  { prefix: "/api/enquiries", section: "enquiries" },
  { prefix: "/api/community-join", section: "enquiries" },
  { prefix: "/api/leads", section: "leads" },
  { prefix: "/api/site-settings", section: "site-settings" },
  { prefix: "/api/master-admin/auth", section: "master-admin-auth" },
  { prefix: "/api/students/auth", section: "students-auth" },
];

const SKIP_PREFIXES = ["/api/activity-logs", "/health", "/uploads"];

function resolveSection(path) {
  const hit = SECTION_MAP.find((item) => path.startsWith(item.prefix));
  return hit?.section || null;
}

function resolveAction(method, path) {
  const lower = path.toLowerCase();
  if (lower.includes("/toggle/")) return "toggle-visibility";
  if (lower.includes("/publish/")) return "toggle-publish";
  if (lower.includes("/avatar")) return "upload-avatar";
  if (method === "POST") return "create";
  if (method === "PUT" || method === "PATCH") return "update";
  if (method === "DELETE") return "delete";
  return method.toLowerCase();
}

function extractResourceId(path) {
  const parts = path.split("/").filter(Boolean);
  // e.g. api / about / 64f... or api / about / toggle / 64f...
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (/^[a-f0-9]{24}$/i.test(part)) return part;
  }
  return "";
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || "";
}

function shouldSkip(path, method) {
  if (method === "GET" || method === "OPTIONS" || method === "HEAD") return true;
  return SKIP_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Logs successful mutating API calls for every CMS/ERP section
 * and pushes them over Socket.IO for live Audit Logs + section refresh.
 */
export function activityLogger(req, res, next) {
  const started = Date.now();
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    try {
      const path = String(req.originalUrl || req.url || "").split("?")[0];
      const method = String(req.method || "").toUpperCase();

      if (!shouldSkip(path, method) && res.statusCode < 400) {
        const section = resolveSection(path);
        if (section) {
          const action = resolveAction(method, path);
          const resourceId =
            extractResourceId(path) ||
            (body?.data && (body.data._id || body.data.id)) ||
            (body?.entry && (body.entry._id || body.entry.id)) ||
            "";

          const actor =
            req.masterAdmin?.email ||
            req.student?.email ||
            body?.data?.updatedBy ||
            body?.data?.createdBy ||
            "anonymous";

          const message =
            (typeof body?.message === "string" && body.message) ||
            `${section} ${action}`;

          void createActivityLog({
            section,
            action,
            method,
            path,
            actor: String(actor),
            resourceId: String(resourceId || ""),
            message,
            statusCode: res.statusCode,
            ip: clientIp(req),
            meta: {
              durationMs: Date.now() - started,
              success: body?.success !== false,
            },
          }).catch((err) => {
            console.error("activity log write failed:", err.message);
          });
        }
      }
    } catch (err) {
      console.error("activity logger error:", err.message);
    }

    return originalJson(body);
  };

  next();
}
