import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

// Connection settings for Amazon DynamoDB, the application's database.
export function dynamoConfig() {
  return {
    region: (process.env.DYNAMODB_REGION || "").trim(),
    endpoint: (process.env.DYNAMODB_ENDPOINT || "").trim(),
    tablePrefix: (process.env.DYNAMODB_TABLE_PREFIX ?? "facultytrack-").trim(),
    accessKeyId: (process.env.DYNAMODB_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: (process.env.DYNAMODB_SECRET_ACCESS_KEY || "").trim(),
  };
}

// DYNAMODB_ENDPOINT=memory keeps every table in this process, for tests and
// local development without AWS; any other endpoint (DynamoDB Local) or the
// default AWS endpoint needs a region and, for AWS, an access key.
export function dynamoConfigurationErrors() {
  const errors = [];
  const config = dynamoConfig();
  if (config.endpoint === "memory") return errors;
  if (!config.region) errors.push("DYNAMODB_REGION is required");
  if (!config.endpoint && (!config.accessKeyId || !config.secretAccessKey)) {
    errors.push("DYNAMODB_ACCESS_KEY_ID and DYNAMODB_SECRET_ACCESS_KEY are required");
  }
  if (!/^[A-Za-z0-9._-]*$/.test(config.tablePrefix)) {
    errors.push("DYNAMODB_TABLE_PREFIX may contain only letters, digits, dot, dash and underscore");
  }
  return errors;
}

export function createDynamoClient(config = dynamoConfig()) {
  let credentials;
  if (config.accessKeyId && config.secretAccessKey) {
    credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  } else if (config.endpoint) {
    credentials = { accessKeyId: "local", secretAccessKey: "local" };
  } else {
    throw new Error(
      "DYNAMODB_ACCESS_KEY_ID and DYNAMODB_SECRET_ACCESS_KEY must both be set "
      + "(the SES key is never used for DynamoDB)"
    );
  }
  return new DynamoDBClient({
    region: config.region || "ap-south-1",
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    credentials,
    maxAttempts: 3,
  });
}
