import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateContinuousBackupsCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";

/**
 * Every DynamoDB table the application uses, in one place, so the setup
 * script, the tests and the migration plan cannot drift apart. Names are
 * prefixed with DYNAMODB_TABLE_PREFIX (facultytrack- by default).
 *
 * Tables are added here as their stores move off MongoDB.
 */
export const DYNAMO_TABLES = Object.freeze([
  {
    store: "app_settings",
    attributes: [{ AttributeName: "_id", AttributeType: "S" }],
    keySchema: [{ AttributeName: "_id", KeyType: "HASH" }],
  },
]);

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
 * tables; DynamoDB Local and test doubles do not support them.
 */
export async function ensureDynamoTables(client, {
  prefix = "facultytrack-",
  apply = false,
  protect = true,
  tables = DYNAMO_TABLES,
} = {}) {
  const report = { existing: [], created: [], missing: [], conflicts: [] };
  for (const definition of tables) {
    const name = `${prefix}${definition.store}`;
    let description = null;
    try {
      ({ Table: description } = await client.send(new DescribeTableCommand({ TableName: name })));
    } catch (error) {
      if (error?.name !== "ResourceNotFoundException") throw error;
    }

    if (description) {
      if (sameKeySchema(description.KeySchema, definition.keySchema)) report.existing.push(name);
      else report.conflicts.push(`${name}: key schema differs from the definition`);
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
    if (protect) {
      await client.send(new UpdateContinuousBackupsCommand({
        TableName: name,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }));
    }
    report.created.push(name);
  }
  return report;
}
