import { MongoClient } from "mongodb";
import {
  applyDatabaseIndexes,
  assertDatabasePreflightSafe,
  auditDatabasePreflight,
  DATABASE_INDEX_APPLY_CONFIRMATION,
  DatabasePreflightError,
} from "./databasePreflight.js";
import { isProduction, runtimeConfig } from "./env.js";

let client = null;
let db = null;

export function getDb() {
  return db;
}

export async function withMongoTransaction(work) {
  if (!client) throw new Error("MongoDB client is not connected");
  const session = client.startSession();
  try {
    return await session.withTransaction(
      () => work(session),
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      }
    );
  } finally {
    await session.endSession();
  }
}

export async function connectToMongo() {
  const config = runtimeConfig();
  if (!config.mongoUri) {
    console.log("WARNING: MONGODB_URI not set. Running without database.");
    return null;
  }
  client = new MongoClient(config.mongoUri, {
    appName: "facultytrack-api",
    maxPoolSize: 20,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 120000,
    retryWrites: true,
  });
  try {
    await client.connect();
    db = client.db(config.dbName);
    await db.command({ ping: 1 });

    const preflight = await auditDatabasePreflight(db);
    assertDatabasePreflightSafe(preflight);
    if (isProduction()) {
      if (!preflight.indexes.ready) {
        throw new DatabasePreflightError(
          preflight,
          "Required database indexes are missing; run the confirmed preflight apply job before production startup"
        );
      }
    } else if (!preflight.indexes.ready) {
      await applyDatabaseIndexes(db, { confirmation: DATABASE_INDEX_APPLY_CONFIRMATION });
    }
  } catch (error) {
    await client.close().catch(() => {});
    client = null;
    db = null;
    throw error;
  }
  console.log("Connected to MongoDB cluster.");
  return db;
}

export async function checkMongoConnection() {
  if (!db) return false;
  try {
    await db.command({ ping: 1 }, { timeoutMS: 1500 });
    return true;
  } catch {
    return false;
  }
}

export async function closeMongoConnection() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log("Closed MongoDB connection.");
  }
}
