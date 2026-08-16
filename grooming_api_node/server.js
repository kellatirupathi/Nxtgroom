import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  checkMongoConnection,
  closeMongoConnection,
  connectToMongo,
} from "./src/config/db.js";
import { isProduction, runtimeConfig, validateEnvironment } from "./src/config/env.js";
import {
  getCurrentUser,
  getPasswordHash,
  requireDatabase,
  ROLES,
} from "./src/middleware/auth.js";
import { adminRouter } from "./src/routes/adminRoutes.js";
import { attendanceRouter } from "./src/routes/attendanceRoutes.js";
import { authRouter } from "./src/routes/authRoutes.js";
import { instructorRouter } from "./src/routes/instructorRoutes.js";
import { startEvaluationWorker } from "./src/services/evaluationWorker.js";
import { startNotificationWorker } from "./src/services/notificationWorker.js";
import { verifyVisionAssets } from "./src/services/visionEngine.js";
import { getWorkerReadiness } from "./src/services/workerHealth.js";
import { createDocument } from "./src/utils.js";

const config = runtimeConfig();

export const app = express();
app.disable("x-powered-by");
if (isProduction()) app.set("trust proxy", 1);

app.use((req, res, next) => {
  req.requestId = randomUUID();
  res.set("X-Request-ID", req.requestId);
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.origins.includes(origin.replace(/\/$/, ""))) {
      return callback(null, true);
    }
    const error = new Error("Origin is not allowed by CORS");
    error.statusCode = 403;
    return callback(error);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  maxAge: 86400,
}));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProduction() ? 600 : 5000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS" || req.path.startsWith("/health"),
  message: { detail: "Too many requests. Please try again later." },
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProduction() ? 10 : 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { detail: "Too many login attempts. Please try again later." },
});

app.get("/", (_req, res) => {
  res.json({ message: "NxtWave Grooming Standards API", version: "2" });
});
app.get("/health/live", (_req, res) => {
  res.json({ status: "ok" });
});

async function readinessStatus() {
  const databaseReady = Boolean(app.locals.db) && await checkMongoConnection();
  if (!databaseReady) {
    return {
      ready: false,
      status: "degraded",
      reasons: ["DATABASE_UNAVAILABLE"],
      workers: [],
      queues: [],
    };
  }
  return getWorkerReadiness(app.locals.db);
}

async function readinessHandler(_req, res) {
  const health = await readinessStatus();
  return res.status(health.ready ? 200 : 503).json(health);
}

app.get("/health/ready", readinessHandler);
app.get("/health", readinessHandler);

app.use("/api/v2/auth/login", loginLimiter);
app.use("/api/v2/auth", requireDatabase, authRouter);
app.use("/api/v2", requireDatabase, getCurrentUser, adminRouter);
app.use("/api/v2/instructors", requireDatabase, getCurrentUser, instructorRouter);
app.use("/api/v2/attendance", requireDatabase, getCurrentUser, attendanceRouter);

app.use((_req, res) => res.status(404).json({ detail: "Not found" }));
app.use((error, req, res, _next) => {
  if (res.headersSent) return;
  if (isProduction()) {
    console.error(`Request ${req.requestId} failed: ${error.name || "Error"}`);
  } else {
    console.error(error);
  }
  if (error.statusCode) return res.status(error.statusCode).json({ detail: error.message });
  if (error.code === 11000) return res.status(409).json({ detail: "A unique value already exists" });
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ detail: "Invalid JSON request body" });
  }
  if (error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ detail: "The image must be 8 MB or smaller" });
  }
  if (error.name === "MulterError" || error.message?.includes("image uploads are allowed")) {
    return res.status(400).json({ detail: error.message });
  }
  return res.status(500).json({ detail: "Internal server error", request_id: req.requestId });
});

export async function seedAdmin(db) {
  const currentConfig = runtimeConfig();
  const now = new Date();
  let user = await db.collection("users").findOne({ email: currentConfig.adminEmail });
  if (user?.disabled_at) {
    throw new Error("The configured bootstrap administrator account is disabled");
  }

  // Adopt and rotate one old bootstrap account so an admin@123 hash cannot
  // survive the first production deployment under a different email.
  if (!user) {
    const legacyBootstrap = await db.collection("users").findOne({
      email: "admin@nxtwave.com",
      role: ROLES.SUPER_ADMIN,
      password_version: { $exists: false },
      disabled_at: { $exists: false },
    });
    if (legacyBootstrap) {
      await db.collection("users").updateOne(
        { _id: legacyBootstrap._id },
        {
          $set: {
            email: currentConfig.adminEmail,
            password_hash: await getPasswordHash(currentConfig.adminPassword),
            password_version: currentConfig.adminPasswordVersion,
            bootstrap_managed: true,
            updated_at: now,
          },
          $inc: { session_version: 1 },
        }
      );
      console.log("Migrated and rotated the legacy bootstrap administrator.");
      user = {
        ...legacyBootstrap,
        email: currentConfig.adminEmail,
        password_version: currentConfig.adminPasswordVersion,
      };
    } else {
      const unknownLegacyAdmin = await db.collection("users").findOne({
        role: ROLES.SUPER_ADMIN,
        password_version: { $exists: false },
        disabled_at: { $exists: false },
      });
      if (unknownLegacyAdmin) {
        throw new Error("An unversioned legacy administrator must be migrated or disabled manually");
      }
    }
  }

  if (!user) {
    user = createDocument({
      email: currentConfig.adminEmail,
      password_hash: await getPasswordHash(currentConfig.adminPassword),
      password_version: currentConfig.adminPasswordVersion,
      role: ROLES.SUPER_ADMIN,
      reference_id: null,
      bootstrap_managed: true,
      session_version: 1,
      created_at: now,
      updated_at: now,
    });
    await db.collection("users").insertOne(user);
    console.log("Created the configured bootstrap administrator.");
  }

  if (user.role !== ROLES.SUPER_ADMIN) {
    throw new Error("ADMIN_EMAIL belongs to a non-administrator account");
  }
  if (user.password_version !== currentConfig.adminPasswordVersion) {
    await db.collection("users").updateOne(
      { _id: user._id },
      {
        $set: {
          password_hash: await getPasswordHash(currentConfig.adminPassword),
          password_version: currentConfig.adminPasswordVersion,
          bootstrap_managed: true,
          updated_at: now,
        },
        $inc: { session_version: 1 },
      }
    );
    console.log("Rotated the configured bootstrap administrator password.");
  }
  const unmanagedLegacyAdmin = await db.collection("users").findOne(
    {
      role: ROLES.SUPER_ADMIN,
      email: { $ne: currentConfig.adminEmail },
      password_version: { $exists: false },
      disabled_at: { $exists: false },
    }
  );
  if (unmanagedLegacyAdmin) {
    throw new Error("An unversioned legacy administrator must be migrated or disabled manually");
  }
}

export async function startServer() {
  const currentConfig = validateEnvironment();
  const db = await connectToMongo();
  if (!db) throw new Error("MongoDB is required to start the API");
  app.locals.db = db;
  await verifyVisionAssets();
  await seedAdmin(db);

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(currentConfig.port, "0.0.0.0", () => resolve(listener));
    listener.once("error", reject);
  });
  const workers = [startEvaluationWorker(db), startNotificationWorker(db)];
  server.requestTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 5_000;
  console.log(`Grooming API listening on port ${currentConfig.port}.`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    const forceExit = setTimeout(() => {
      console.error("Graceful shutdown timed out.");
      process.exit(1);
    }, 20_000);
    forceExit.unref();
    await Promise.allSettled([
      new Promise((resolve) => server.close(resolve)),
      ...workers.map((worker) => worker.stop()),
    ]);
    await closeMongoConnection();
    clearTimeout(forceExit);
  };
  const fatalShutdown = (error) => {
    process.exitCode = 1;
    console.error(`Fatal process error: ${error?.name || "Error"}`);
    void shutdown("fatal error");
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("uncaughtException", fatalShutdown);
  process.once("unhandledRejection", fatalShutdown);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer().catch((error) => {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  });
}
