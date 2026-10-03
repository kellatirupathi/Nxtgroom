import assert from "node:assert/strict";
import { test } from "node:test";
import { createDynamoClient } from "../src/config/dynamo.js";
import { ensureDynamoTables } from "../src/stores/dynamoTables.js";

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

function fakeAws({ exists = true, unavailable = 0, backupError = null } = {}) {
  const calls = [];
  let backupAttempts = 0;
  return {
    calls,
    async send(command) {
      const name = command.constructor.name;
      calls.push(name);
      if (name === "DescribeTableCommand") {
        if (!exists) throw Object.assign(new Error("absent"), { name: "ResourceNotFoundException" });
        return { Table: { KeySchema: [{ AttributeName: "_id", KeyType: "HASH" }] } };
      }
      if (name === "UpdateContinuousBackupsCommand") {
        backupAttempts += 1;
        if (backupError) throw backupError;
        if (backupAttempts <= unavailable) {
          throw Object.assign(new Error("Backups are being enabled"), { name: "ContinuousBackupsUnavailableException" });
        }
        return {};
      }
      throw new Error(`unexpected ${name}`);
    },
  };
}

const oneTable = [{
  store: "app_settings",
  attributes: [{ AttributeName: "_id", AttributeType: "S" }],
  keySchema: [{ AttributeName: "_id", KeyType: "HASH" }],
}];

test("backups are retried while AWS is still preparing them", async () => {
  const aws = fakeAws({ unavailable: 2 });
  const slept = [];
  const report = await ensureDynamoTables(aws, {
    apply: true,
    tables: oneTable,
    sleep: async (ms) => { slept.push(ms); },
  });
  assert.deepEqual(report.backups, ["facultytrack-app_settings"]);
  assert.deepEqual(report.backupsPending, []);
  assert.deepEqual(slept, [5000, 10000]);
});

test("a table that already exists gets its backups switched on by --apply", async () => {
  const aws = fakeAws();
  const report = await ensureDynamoTables(aws, { apply: true, tables: oneTable, sleep: async () => {} });
  assert.deepEqual(report.existing, ["facultytrack-app_settings"]);
  assert.deepEqual(report.backups, ["facultytrack-app_settings"]);
  assert.ok(aws.calls.includes("UpdateContinuousBackupsCommand"));
});

test("backups still unavailable after every retry are reported, not thrown", async () => {
  const aws = fakeAws({ unavailable: 100 });
  const report = await ensureDynamoTables(aws, { apply: true, tables: oneTable, sleep: async () => {} });
  assert.deepEqual(report.backups, []);
  assert.deepEqual(report.backupsPending, ["facultytrack-app_settings"]);
});

test("any other backup error still fails loudly", async () => {
  const aws = fakeAws({ backupError: Object.assign(new Error("no"), { name: "AccessDeniedException" }) });
  await assert.rejects(
    ensureDynamoTables(aws, { apply: true, tables: oneTable, sleep: async () => {} }),
    /no/
  );
});

test("the read-only check never touches backups", async () => {
  const aws = fakeAws();
  const report = await ensureDynamoTables(aws, { apply: false, tables: oneTable });
  assert.deepEqual(report.backups, []);
  assert.deepEqual(aws.calls, ["DescribeTableCommand"]);
});

test("DynamoDB Local, which has no backups, is left alone", async () => {
  const aws = fakeAws();
  await ensureDynamoTables(aws, { apply: true, protect: false, tables: oneTable });
  assert.deepEqual(aws.calls, ["DescribeTableCommand"]);
});
