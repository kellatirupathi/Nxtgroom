// Sets up the application's DynamoDB tables, and copies data in from the old
// MongoDB database (a one-time move).
//
//   node scripts/dynamodb-database.js tables            list what is missing
//   node scripts/dynamodb-database.js tables --apply    create tables, indexes, TTL, backups
//   node scripts/dynamodb-database.js migrate           count what would be copied
//   node scripts/dynamodb-database.js migrate --apply   copy MongoDB -> DynamoDB (safe to repeat)
//   ... migrate --apply --prune                         also remove documents deleted from MongoDB
//   node scripts/dynamodb-database.js verify            compare every document and unique guard
//
// Options: --collection <name> limits migrate/verify to one collection;
//          --no-backups skips point-in-time recovery on new tables.
// MongoDB is only ever read. DynamoDB settings come from DYNAMODB_REGION,
// DYNAMODB_ACCESS_KEY_ID, DYNAMODB_SECRET_ACCESS_KEY and DYNAMODB_TABLE_PREFIX.
//
// The application no longer depends on MongoDB, so migrate and verify need its
// driver installed for the run:  npm install --no-save mongodb@6
// and MONGODB_URI (plus DB_NAME if not grooming_standards) set.

import "dotenv/config";
import { createDynamoDocumentDatabase } from "../src/config/db.js";
import { dynamoConfig } from "../src/config/dynamo.js";
import { COLLECTION_NAMES } from "../src/docdb/schema.js";
import { copyCollections, ensureTables, verifyCollections } from "../src/docdb/migrate.js";

const [command] = process.argv.slice(2);
const apply = process.argv.includes("--apply");
const collectionIndex = process.argv.indexOf("--collection");
const only = collectionIndex > -1 ? process.argv[collectionIndex + 1] : null;
const collections = only ? [only] : COLLECTION_NAMES;

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/dynamodb-database.js tables|migrate|verify [--apply] [--collection name] [--no-backups]");
  process.exitCode = 2;
}

async function withMongo(work) {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required to read the data being moved");
  let MongoClient;
  try {
    ({ MongoClient } = await import("mongodb"));
  } catch {
    throw new Error("The MongoDB driver is not installed. Run: npm install --no-save mongodb@6");
  }
  const client = new MongoClient(uri, {
    appName: "facultytrack-dynamodb-migration",
    readPreference: "secondaryPreferred",
    serverSelectionTimeoutMS: 10000,
  });
  await client.connect();
  try {
    return await work(client.db(process.env.DB_NAME || "grooming_standards"));
  } finally {
    await client.close();
  }
}

async function main() {
  if (!["tables", "migrate", "verify"].includes(command)) return usage();
  if (only && !COLLECTION_NAMES.includes(only)) return usage(`Unknown collection ${only}`);
  const config = dynamoConfig();
  if (config.endpoint === "memory") return usage("DYNAMODB_ENDPOINT=memory is in-process only; point it at AWS or DynamoDB Local");
  const target = createDynamoDocumentDatabase();
  console.log(`DynamoDB region ${config.region || "(endpoint)"}, table prefix "${config.tablePrefix}"`);

  if (command === "tables") {
    const report = await ensureTables(target.driver, target.prefix, {
      apply,
      pointInTimeRecovery: !process.argv.includes("--no-backups"),
      log: (line) => console.log(line),
    });
    for (const entry of report) {
      const note = entry.missingIndexes ? ` (missing indexes: ${entry.missingIndexes.join(", ")})` : "";
      console.log(`${entry.table.padEnd(42)} ${entry.status}${entry.actions.length ? ` -> ${entry.actions.join(", ")}` : ""}${note}`);
    }
    const pending = report.filter((entry) => entry.status !== "ok" && !entry.actions.length);
    if (!apply && pending.length) console.log(`\n${pending.length} table(s) need work. Re-run with --apply.`);
    if (report.some((entry) => entry.status === "index_missing")) {
      console.log("\nA table exists without an index this version needs. Add it in the DynamoDB console or recreate the table.");
      process.exitCode = 1;
    }
    return;
  }

  await withMongo(async (source) => {
    if (command === "migrate") {
      if (!apply) {
        for (const name of collections) {
          console.log(`${name.padEnd(24)} ${await source.collection(name).countDocuments({})} document(s) to copy`);
        }
        console.log("\nDry run only. Re-run with --apply to copy.");
        return;
      }
      const started = Date.now();
      const summary = await copyCollections(source, target, {
        collections,
        prune: process.argv.includes("--prune"),
        log: (line) => console.log(line),
      });
      const total = summary.reduce((sum, row) => sum + row.source, 0);
      console.log(`\nCopied ${total} document(s) in ${Math.round((Date.now() - started) / 1000)}s. Now run: npm run dynamodb:verify`);
      return;
    }
    const results = await verifyCollections(source, target, { collections });
    for (const row of results) {
      console.log(
        `${row.ok ? "OK  " : "FAIL"} ${row.collection.padEnd(22)} mongodb ${String(row.source).padStart(6)}  dynamodb ${String(row.dynamodb).padStart(6)}`
        + `  missing ${row.missing}  different ${row.different}  extra ${row.extra}  bad unique guards ${row.bad_guards}`
        + (row.examples.length ? `  e.g. ${row.examples.join(", ")}` : "")
      );
    }
    if (results.every((row) => row.ok)) console.log("\nEvery document matches.");
    else process.exitCode = 1;
  });
}

main().catch((error) => {
  console.error(`Failed: ${error.message}`);
  process.exitCode = 1;
});
