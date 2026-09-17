import { MongoClient } from "mongodb";
import {
  applyDatabaseIndexes,
  DATABASE_INDEX_APPLY_CONFIRMATION,
  DatabasePreflightError,
  migrateLegacyActiveAttendanceIndex,
  migrateLegacyDailyAttendanceIndex,
  migrateLegacyEvaluationIdentityIndex,
  verifyDatabaseIndexes,
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

    const evaluationIndexMigration = await migrateLegacyEvaluationIdentityIndex(db);
    if (evaluationIndexMigration.migrated) {
      console.log(
        `Migrated evaluation identity index; backfilled ${evaluationIndexMigration.backfilled} legacy evaluation(s).`
      );
    }
    const attendanceIndexMigration = await migrateLegacyActiveAttendanceIndex(db);
    if (attendanceIndexMigration.migrated) {
      console.log("Migrated attendance uniqueness from global-open to one record per local day.");
    }
    const dailyIndexMigration = await migrateLegacyDailyAttendanceIndex(db);
    if (dailyIndexMigration.migrated) {
      console.log("Migrated daily attendance uniqueness to exclude unidentified records.");
    }
    /**
     * Startup checks the indexes, and nothing else.
     *
     * The full audit reads six collections in their entirety to look for
     * duplicates and dangling references — every evaluation ever written among
     * them, which is two rows per check-in and grows forever. On a 512MB
     * container that crosses the limit inside a year, and it crosses it during
     * startup, so the symptom is a container killed before it can serve and
     * restarted into the same wall.
     *
     * Nothing is lost by moving it. The audit reports; it never repairs, since
     * only a person can say which of two colliding records is the real one. And
     * corruption appears when something writes it during the day, not when a
     * process starts, so running the check here found it no sooner than a
     * nightly `npm run db:preflight` does — it only made the finding arrive at
     * the moment least able to act on it. That is not hypothetical: one
     * unrecognised check-in was read as a dangling reference and kept the API
     * down through eight restarts.
     *
     * verifyDatabaseIndexes stays because it is cheap — it lists index names
     * and compares them — and because serving without the indexes is a real
     * fault rather than a report: queries that should use an index would
     * quietly scan instead.
     */
    const indexes = await verifyDatabaseIndexes(db);
    if (isProduction()) {
      if (!indexes.ready) {
        throw new DatabasePreflightError(
          // Shaped like an audit report because that is what the error prints.
          // There are no findings here: this path knows about indexes only, and
          // claiming otherwise would put an empty corruption list in a message
          // about missing indexes.
          { findings: [], indexes, summary: { missing_indexes: indexes.missing.length } },
          "Required database indexes are missing; run the confirmed preflight apply job before production startup"
        );
      }
    } else if (!indexes.ready) {
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
