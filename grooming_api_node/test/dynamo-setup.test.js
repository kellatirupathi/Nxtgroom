import assert from "node:assert/strict";
import { test } from "node:test";
import { createDynamoClient } from "../src/config/dynamo.js";

/**
 * Met while creating the first table on the server: with the DynamoDB keys
 * missing, the client fell back to the SDK's default credentials, i.e. the
 * SES sender's AWS_ACCESS_KEY_ID, and the failure read as AccessDenied for
 * the mail user.
 */

test("a missing DynamoDB key is refused instead of falling back to the SES key", () => {
  const base = { region: "ap-south-1", endpoint: "", tablePrefix: "facultytrack-" };
  assert.throws(
    () => createDynamoClient({ ...base, accessKeyId: "", secretAccessKey: "" }),
    /DYNAMODB_ACCESS_KEY_ID and DYNAMODB_SECRET_ACCESS_KEY must both be set/
  );
  assert.throws(
    () => createDynamoClient({ ...base, accessKeyId: "AKIAEXAMPLE", secretAccessKey: "" }),
    /must both be set/,
    "half a key pair is refused too"
  );
  createDynamoClient({ ...base, accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" }).destroy();
  createDynamoClient({ ...base, endpoint: "http://localhost:8001", accessKeyId: "", secretAccessKey: "" }).destroy();
});
