import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateContinuousBackupsCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { toItem } from "./dynamoItems.js";

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
    attributes: [
      { AttributeName: "attendance_id", AttributeType: "S" },
      { AttributeName: "kind", AttributeType: "S" },
    ],
    keySchema: [
      { AttributeName: "attendance_id", KeyType: "HASH" },
      { AttributeName: "kind", KeyType: "RANGE" },
    ],
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

const BACKUP_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000];

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
