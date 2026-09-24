import http from "http";
import express from "express";
import cors from "cors";
import path from "path";
import mongoose from "mongoose";
import { env } from "./config/env.js";
import masterAdminAuthRoutes from "./routes/masterAdminAuth.routes.js";
import studentAuthRoutes from "./routes/studentAuth.routes.js";
import studentNotificationsRoutes from "./routes/studentNotifications.routes.js";
import enquiriesRoutes from "./modules/enquiries/enquiries.routes.js";
import leadsRoutes from "./modules/leads/leads.routes.js";
import siteSettingsRoutes from "./routes/siteSettings.routes.js";
import admissionsRoutes from "./routes/admissions.routes.js";
import aboutRoutes from "./modules/about/about.routes.js";
import expertiseRoutes from "./modules/expertise/expertise.routes.js";
import processRoutes from "./modules/process/process.routes.js";
import servicesRoutes from "./modules/services/services.routes.js";
import caseStudyRoutes from "./modules/caseStudy/caseStudy.routes.js";
import faqRoutes from "./modules/faq/faq.routes.js";
import heroLeftRoutes from "./modules/heroLeft/heroLeft.routes.js";
import universitiesRoutes from "./modules/universities/universities.routes.js";
import coursesRoutes from "./modules/courses/courses.routes.js";
import feesRoutes from "./modules/fees/fees.routes.js";
import studentFeesRoutes from "./modules/fees/studentFees.routes.js";
import attendanceRoutes from "./modules/attendance/attendance.routes.js";
import batchesRoutes from "./modules/batches/batches.routes.js";
import facultiesRoutes from "./modules/faculties/faculty.routes.js";
import staffRoutes from "./modules/staff/staff.routes.js";
import activityLogRoutes from "./modules/activityLog/activityLog.routes.js";
import masterAdminStudentsRoutes from "./routes/masterAdmin.students.routes.js";
import workshopRoutes from "./modules/workshop/workshop.routes.js";
import { activityLogger } from "./middleware/activityLogger.js";
import { requireDbReady } from "./middleware/requireDbReady.js";
import { initSocket } from "./lib/socket.js";
import { connectMongo } from "./db/connectMongo.js";
import { seedEnquiriesDemo } from "./db/seedEnquiriesDemo.js";
import { seedLeadsDemo } from "./db/seedLeadsDemo.js";
import { seedSiteSettingsDemo } from "./db/seedSiteSettingsDemo.js";
import { seedAboutDemo } from "./db/seedAboutDemo.js";
import { seedExpertiseDemo } from "./db/seedExpertiseDemo.js";
import { seedProcessDemo } from "./db/seedProcessDemo.js";
import { seedServicesDemo } from "./db/seedServicesDemo.js";
import { seedCaseStudyDemo } from "./db/seedCaseStudyDemo.js";
import { seedFaqDemo } from "./db/seedFaqDemo.js";
import { seedHeroLeftDemo } from "./db/seedHeroLeftDemo.js";
import { seedUniversitiesDemo } from "./db/seedUniversitiesDemo.js";
import { seedMasterAdminUser } from "./db/seedMasterAdminUser.js";
import { seedBatchesAndAttendance } from "./db/seedBatchesAndAttendance.js";
import { seedFacultyDemo } from "./db/seedFacultyDemo.js";

const app = express();
const server = http.createServer(app);

initSocket(server);

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: "5mb" }));
app.use(activityLogger);

app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

function healthResponse(_req, res) {
  const mongoReady = mongoose.connection.readyState === 1;
  res.status(mongoReady ? 200 : 503).json({
    success: mongoReady,
    ok: mongoReady,
    mongoReady,
    readyState: mongoose.connection.readyState,
  });
}

app.get("/health", healthResponse);
// Keep the health endpoint outside the database readiness middleware so it can
// report the actual connection state while MongoDB is unavailable.
app.get("/api/health", healthResponse);

app.get("/", (_req, res) => {
  res.json({
    success: true,
    service: "Grow Skills Tech API",
    message: "API is running",
    health: "/api/health",
  });
});

// Vercel may pass the rewritten function path as /api/index.js for the root
// rewrite. Treat it as the API root instead of returning a framework 404.
app.get("/api/index.js", (_req, res) => {
  res.json({
    success: true,
    service: "Grow Skills Tech API",
    message: "API is running",
    health: "/api/health",
  });
});

// Fail fast on API while Mongo is reconnecting (avoids long hung logins)
app.use("/api", requireDbReady);

app.use("/api/master-admin/auth", masterAdminAuthRoutes);
app.use("/api/students/auth", studentAuthRoutes);
app.use("/api/students/notifications", studentNotificationsRoutes);
app.use("/api/students/fees", studentFeesRoutes);
app.use("/api/enquiries", enquiriesRoutes);
// Legacy alias — same handlers as /api/enquiries
app.use("/api/community-join", enquiriesRoutes);
app.use("/api/leads", leadsRoutes);
app.use("/api/site-settings", siteSettingsRoutes);
app.use("/api/admissions", admissionsRoutes);
app.use("/api/about", aboutRoutes);
app.use("/api/expertise", expertiseRoutes);
app.use("/api/process", processRoutes);
app.use("/api/services", servicesRoutes);
app.use("/api/case-study", caseStudyRoutes);
app.use("/api/faq", faqRoutes);
app.use("/api/hero-left", heroLeftRoutes);
app.use("/api/universities", universitiesRoutes);
app.use("/api/courses", coursesRoutes);
app.use("/api/fees", feesRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/batches", batchesRoutes);
app.use("/api/faculties", facultiesRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/activity-logs", activityLogRoutes);
app.use("/api/master-admin/students", masterAdminStudentsRoutes);
app.use("/api/workshop-registrations", workshopRoutes);

app.use((_req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: "Internal server error" });
});

async function runSeeds() {
  await seedMasterAdminUser();
  await seedEnquiriesDemo();
  await seedLeadsDemo();
  await seedSiteSettingsDemo();
  await seedAboutDemo();
  await seedExpertiseDemo();
  await seedProcessDemo();
  await seedServicesDemo();
  await seedCaseStudyDemo();
  await seedFaqDemo();
  await seedHeroLeftDemo();
  await seedUniversitiesDemo();
  await seedBatchesAndAttendance();
  await seedFacultyDemo();
  console.log("Demo seeds finished");
}

function listen() {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${env.port} is already in use. Stop the other server process and try again.`
          )
        );
        return;
      }
      reject(err);
    };

    server.once("error", onError);
    server.listen(env.port, () => {
      server.off("error", onError);
      console.log(`Server listening on http://localhost:${env.port}`);
      console.log(`Socket.IO ready for live section logs`);
      resolve();
    });
  });
}

async function shutdown(signal) {
  console.log(`Shutting down (${signal})...`);
  try {
    await new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 800);
    });
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch {
    // ignore — watch mode will kill the process anyway
  }
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

export async function connectMongoWithRetry() {
  for (;;) {
    try {
      await connectMongo();
      return;
    } catch (err) {
      console.error(
        "MongoDB connect failed, retrying in 3s:",
        err?.message || err
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function start() {
  console.log("Booting API...");

  // Keep HTTP up even if Atlas DNS flaps — login should not get "connection refused"
  await listen();
  await connectMongoWithRetry();

  // Heavy demo seeds already live in Atlas — skip on every watch restart.
  // Run `npm run seed` or set SEED_ON_START=1 when you actually need them.
  if (process.env.SEED_ON_START === "1") {
    runSeeds().catch((err) => {
      console.error("Background seed failed:", err?.message || err);
    });
  } else {
    seedMasterAdminUser().catch((err) => {
      console.error("Master-admin seed failed:", err?.message || err);
    });
  }
}

export { app };

// Vercel imports the Express app from api/index.js and manages the listener.
// The long-running boot sequence is only for local/server deployments.
if (!process.env.VERCEL) {
  start().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
