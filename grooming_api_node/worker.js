import "dotenv/config";
import { closeMongoConnection, connectToMongo } from "./src/config/db.js";
import { validateEnvironment } from "./src/config/env.js";
import { startEvaluationWorker } from "./src/services/evaluationWorker.js";
import { startNotificationWorker } from "./src/services/notificationWorker.js";
import { startStorageCleanupWorker } from "./src/services/storageCleanupWorker.js";
import { startMailWorker } from "./src/services/mailWorker.js";
import { verifyVisionAssets } from "./src/services/visionEngine.js";

async function startWorkers() {
  const config = validateEnvironment();
  if (config.processRole !== "worker") {
    throw new Error("worker.js requires PROCESS_ROLE=worker");
  }
  const db = await connectToMongo();
  if (!db) throw new Error("MongoDB is required to start workers");
  await verifyVisionAssets();
  const workers = [
    startEvaluationWorker(db),
    startNotificationWorker(db),
    startStorageCleanupWorker(db),
    startMailWorker(db),
  ];
  console.log("FacultyTrack workers started.");

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; stopping workers.`);
    await Promise.allSettled(workers.map((worker) => worker.stop()));
    await closeMongoConnection();
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

startWorkers().catch((error) => {
  console.error(`Failed to start workers: ${error.message}`);
  process.exit(1);
});
