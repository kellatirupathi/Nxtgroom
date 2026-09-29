import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateContinuousBackupsCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { toItem } from "./dynamoItems.js";

/**
 * Every DynamoDB table the application uses, in one place, so the setup
 * script, the tests and the migration plan cannot drift apart. Names are
 * prefixed with DYNAMODB_TABLE_PREFIX (facultytrack- by default).
 *
 * Tables are added here as their stores move off MongoDB. itemFromDocument
 * turns a MongoDB document into its DynamoDB item for the copy and compare
 * scripts, and keyOf identifies an item for the comparison.
 */
const byId = {
  attributes: [{ AttributeName: "_id", AttributeType: "S" }],
  keySchema: [{ AttributeName: "_id", KeyType: "HASH" }],
  itemFromDocument: (document) => toItem(document),
  keyOf: (item) => String(item._id),
};

export const DYNAMO_TABLES = Object.freeze([
  { store: "app_settings", ...byId },
  { store: "report_delivery_runs", ...byId },
  {
    store: "evaluations",
    // The pair is the MongoDB unique index (attendance_id, kind).
    attributes: [
      { AttributeName: "attendance_id", AttributeType: "S" },
      { AttributeName: "kind", AttributeType: "S" },
    ],
    keySchema: [
      { AttributeName: "attendance_id", KeyType: "HASH" },
      { AttributeName: "kind", KeyType: "RANGE" },
    ],
    // Evaluations stored before check-out analysis existed have no kind;
    // all of them are check-ins (see evaluationFilter).
    itemFromDocument: (document) => {
      const item = toItem(document);
      return { ...item, attendance_id: String(item.attendance_id), kind: item.kind === "checkout" ? "checkout" : "checkin" };
    },
    keyOf: (item) => `${item.attendance_id}#${item.kind}`,
  },
]);

export function dynamoTableDefinition(store) {
  const definition = DYNAMO_TABLES.find((table) => table.store === store);
  if (!definition) throw new Error(`No DynamoDB table is defined for ${store}`);
  return definition;
}

function sameKeySchema(actual = [], expected = []) {
  const normalise = (schema) => schema.map((key) => `${key.AttributeName}:${key.KeyType}`).join(",");
  return normalise(actual) === normalise(expected);
}

/**
 * Creates the tables that are missing and reports the rest. Never deletes or
 * alters an existing table; a table whose key differs from the definition is
 * reported as a conflict for a person to resolve.
 *
 * Pay-per-request billing (no capacity to plan, no throttling at the 9 AM
 * rush). Deletion protection and point-in-time recovery are on for real AWS
 * tables; DynamoDB Local and test doubles do not support them. With apply,
 * backups are switched on for existing tables too, so a table created before
 * backups could be enabled is fixed by running the command again.
 */
// Right after CreateTable, AWS is still setting up backups for the table and
// refuses to change them for a minute or two.
const BACKUP_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000];

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Turns point-in-time recovery on. Asking again when it is already on
 * changes nothing, so this runs for every table on each --apply: a table
 * whose first attempt failed is fixed by simply running the command again.
 */
async function enableBackups(client, name, sleep) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.send(new UpdateContinuousBackupsCommand({
        TableName: name,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }));
      return true;
    } catch (error) {
      if (error?.name !== "ContinuousBackupsUnavailableException") throw error;
      if (attempt >= BACKUP_RETRY_DELAYS_MS.length) return false;
      await sleep(BACKUP_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export async function ensureDynamoTables(client, {
  prefix = "facultytrack-",
  apply = false,
  protect = true,
  tables = DYNAMO_TABLES,
  sleep = wait,
} = {}) {
  const report = { existing: [], created: [], missing: [], conflicts: [], backups: [], backupsPending: [] };
  const protectTable = async (name) => {
    if (!apply || !protect) return;
    if (await enableBackups(client, name, sleep)) report.backups.push(name);
    else report.backupsPending.push(name);
  };
  for (const definition of tables) {
    const name = `${prefix}${definition.store}`;
    let description = null;
    try {
      ({ Table: description } = await client.send(new DescribeTableCommand({ TableName: name })));
    } catch (error) {
      if (error?.name !== "ResourceNotFoundException") throw error;
    }

    if (description) {
      if (sameKeySchema(description.KeySchema, definition.keySchema)) {
        report.existing.push(name);
        await protectTable(name);
      } else {
        report.conflicts.push(`${name}: key schema differs from the definition`);
      }
      continue;
    }
    if (!apply) {
      report.missing.push(name);
      continue;
    }

    await client.send(new CreateTableCommand({
      TableName: name,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: definition.attributes,
      KeySchema: definition.keySchema,
      ...(protect ? { DeletionProtectionEnabled: true } : {}),
      Tags: [{ Key: "app", Value: "facultytrack" }],
    }));
    await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: name });
    report.created.push(name);
    await protectTable(name);
  }
  return report;
}
