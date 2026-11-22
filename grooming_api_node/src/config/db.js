import { createDynamoClient, dynamoConfig } from "./dynamo.js";
import { isProduction } from "./env.js";
import { DynamoDocumentDatabase } from "../docdb/database.js";
import { AwsDynamoDriver, MemoryDynamoDriver } from "../docdb/driver.js";
import { allTableDefinitions } from "../docdb/schema.js";

// The application's database is Amazon DynamoDB. Routes and services use one
// database object with a collection-style API (find, updateOne, ...), which
// src/docdb answers from one DynamoDB table per collection.
let db = null;

export function getDb() {
  return db;
}

// Runs `work` as one transaction: every write inside it commits together or
// not at all, and a conflicting write retries it.
export async function withTransaction(work) {
  if (!db) throw new Error("DynamoDB is not connected");
  return db.withTransaction(work);
}

export function createDynamoDocumentDatabase() {
  const config = dynamoConfig();
  const memory = config.endpoint === "memory";
  if (memory && isProduction()) {
    throw new Error("DYNAMODB_ENDPOINT=memory keeps data only in memory and cannot be used in production");
  }
  const driver = memory
    ? new MemoryDynamoDriver(allTableDefinitions(config.tablePrefix).map((table) => table.definition))
    : new AwsDynamoDriver(createDynamoClient(config));
  return new DynamoDocumentDatabase({
    driver,
    tablePrefix: config.tablePrefix,
    logScans: process.env.DOCDB_LOG_SCANS === "true",
  });
}

async function verifyTables(database) {
  const missing = [];
  for (const { definition } of allTableDefinitions(database.prefix)) {
    const table = await database.driver.describeTable(definition.TableName);
    if (!table) {
      missing.push(definition.TableName);
      continue;
    }
    const indexes = new Set((table.GlobalSecondaryIndexes || []).map((index) => index.IndexName));
    for (const index of definition.GlobalSecondaryIndexes || []) {
      if (!indexes.has(index.IndexName)) missing.push(`${definition.TableName} index ${index.IndexName}`);
    }
  }
  if (missing.length) {
    throw new Error(
      `DynamoDB is missing ${missing.length} table(s) or index(es): ${missing.slice(0, 5).join(", ")}`
      + `${missing.length > 5 ? ", ..." : ""}. Run: npm run dynamodb:tables:apply`
    );
  }
}

export async function connectToDatabase() {
  const database = createDynamoDocumentDatabase();
  await verifyTables(database);
  await database.command({ ping: 1 });
  db = database;
  console.log("Connected to Amazon DynamoDB.");
  return db;
}

export async function checkDatabaseConnection() {
  if (!db) return false;
  try {
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabaseConnection() {
  if (!db) return;
  db = null;
  console.log("Closed DynamoDB connection.");
}
