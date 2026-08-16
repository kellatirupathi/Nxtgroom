import "dotenv/config";
import { MongoClient } from "mongodb";
import {
  applyDatabaseIndexes,
  auditDatabasePreflight,
  DATABASE_INDEX_APPLY_CONFIRMATION,
  formatDatabasePreflightReport,
} from "../src/config/databasePreflight.js";
import { runtimeConfig } from "../src/config/env.js";

const apply = process.argv.includes("--apply");
const json = process.argv.includes("--json");
const config = runtimeConfig();

if (!config.mongoUri) {
  console.error("Database preflight requires MONGODB_URI.");
  process.exitCode = 2;
} else {
  const client = new MongoClient(config.mongoUri, {
    appName: "facultytrack-database-preflight",
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 120000,
    retryWrites: true,
  });
  try {
    await client.connect();
    const db = client.db(config.dbName);
    await db.command({ ping: 1 });
    const report = await auditDatabasePreflight(db);
    console.log(json ? JSON.stringify(report, null, 2) : formatDatabasePreflightReport(report));

    if (report.findings.length || report.indexes.conflicts.length) {
      process.exitCode = 2;
    } else if (apply) {
      if (process.env.DATABASE_PREFLIGHT_APPLY !== DATABASE_INDEX_APPLY_CONFIRMATION) {
        console.error(
          `Apply refused. Set DATABASE_PREFLIGHT_APPLY=${DATABASE_INDEX_APPLY_CONFIRMATION} only for the one-off migration job.`
        );
        process.exitCode = 2;
      } else {
        const result = await applyDatabaseIndexes(db, {
          confirmation: process.env.DATABASE_PREFLIGHT_APPLY,
        });
        console.log(`Index apply completed; ${result.applied.length} missing index(es) created.`);
      }
    } else if (!report.indexes.ready && !json) {
      console.log(
        `Read-only mode made no changes. To create missing indexes, set DATABASE_PREFLIGHT_APPLY=${DATABASE_INDEX_APPLY_CONFIRMATION} and run npm run db:preflight:apply.`
      );
    }
  } catch (error) {
    const name = error?.name || "Error";
    console.error(`Database preflight failed (${name}).`);
    if (name === "DatabasePreflightError" && error.report) {
      console.error(formatDatabasePreflightReport(error.report));
    }
    process.exitCode = 2;
  } finally {
    await client.close().catch(() => {});
  }
}
