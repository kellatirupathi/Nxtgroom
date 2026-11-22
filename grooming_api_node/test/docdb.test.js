import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import dynalite from "dynalite";
import { createDynamoClient } from "../src/config/dynamo.js";
import { decodeDocument, encodeDocument, keyPart, newDocumentId, normalizeValue } from "../src/docdb/codec.js";
import { applyUpdate, DynamoDocumentDatabase } from "../src/docdb/database.js";
import {
  actionRequest,
  AwsDynamoDriver,
  ConditionFailedError,
  MemoryDynamoDriver,
} from "../src/docdb/driver.js";
import { copyCollections, ensureTables, verifyCollections } from "../src/docdb/migrate.js";
import { planQuery } from "../src/docdb/planner.js";
import { allTableDefinitions, collectionSchema, COLLECTION_NAMES, tableDefinition } from "../src/docdb/schema.js";

const PREFIX = "unit-";

function memoryDatabase(options = {}) {
  const driver = new MemoryDynamoDriver(allTableDefinitions(PREFIX).map((table) => table.definition));
  return new DynamoDocumentDatabase({ driver, tablePrefix: PREFIX, ...options });
}

// Records which access path each read used, so tests can assert that indexed
// lookups never fall back to reading a whole table.
function spy(database) {
  const calls = [];
  for (const name of ["getItem", "batchGetItems", "queryIndex", "scanTable"]) {
    const original = database.driver[name].bind(database.driver);
    database.driver[name] = async (...args) => {
      calls.push({ name, table: args[0], index: args[1]?.indexName });
      return original(...args);
    };
  }
  return calls;
}

describe("codec", () => {
  test("round-trips dates, buffers, nulls and odd numbers exactly", () => {
    const document = {
      _id: "x",
      at: new Date("2026-11-19T03:30:00.123Z"),
      nested: { list: [new Date(0), { deep: null }], flag: false },
      bytes: Buffer.from([1, 2, 3]),
      nan: Number.NaN,
      empty: "",
    };
    const back = decodeDocument(encodeDocument(document));
    assert.ok(back.at instanceof Date);
    assert.equal(back.at.toISOString(), "2026-11-19T03:30:00.123Z");
    assert.ok(back.nested.list[0] instanceof Date);
    assert.deepEqual(back.bytes, Buffer.from([1, 2, 3]));
    assert.ok(Number.isNaN(back.nan));
    assert.equal(back.nested.list[1].deep, null);
    assert.equal(back.empty, "");
  });

  test("an ObjectId from the old database becomes its hex string, and undefined becomes null", () => {
    const hex = "6a82eb647377e77789a4bede";
    const id = { _bsontype: "ObjectId", toHexString: () => hex };
    assert.deepEqual(normalizeValue({ a: id, b: undefined, c: [id] }), { a: hex, b: null, c: [hex] });
  });

  test("new ids are unique 24-character hex strings that start with the time", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newDocumentId()));
    assert.equal(ids.size, 1000);
    for (const id of ids) assert.match(id, /^[0-9a-f]{24}$/);
    const seconds = parseInt([...ids][0].slice(0, 8), 16);
    assert.ok(Math.abs(seconds - Date.now() / 1000) < 5);
  });

  test("index keys keep types apart and sort chronologically", () => {
    assert.notEqual(keyPart("2026-11-19"), keyPart(new Date("2026-11-19")));
    assert.ok(keyPart(new Date("2026-01-02")) < keyPart(new Date("2026-11-19")));
    assert.ok(keyPart(-5) < keyPart(3));
    assert.ok(keyPart(3) < keyPart(20));
    assert.equal(keyPart(null), null);
  });
});

describe("planner", () => {
  const attendance = collectionSchema("attendance");

  test("ids, unique keys, indexes and scans are chosen from the filter", () => {
    assert.equal(planQuery(attendance, { _id: { $in: ["a", "b"] } }).kind, "ids");
    assert.equal(planQuery(attendance, { instructor_id: "i1", attendance_day: "2026-11-19" }).kind, "unique");
    const byInstructor = planQuery(attendance, { instructor_id: { $in: ["i1", "i2"] }, check_in_time: { $gte: new Date() } });
    assert.equal(byInstructor.index.name, "by_instructor");
    assert.equal(byInstructor.pkValues.length, 2);
    assert.ok(byInstructor.skFrom.startsWith("d:"));
    assert.equal(planQuery(attendance, { date: { $gte: new Date(0), $lt: new Date() } }).index.name, "by_date");
    assert.equal(planQuery(attendance, { _private_evaluation_outbox: { $exists: true } }).index.name, "evaluation_outbox");
    assert.equal(planQuery(attendance, { status: "pending" }).kind, "scan");
  });

  test("conditions that could miss documents are never pushed down", () => {
    assert.equal(planQuery(attendance, { instructor_id: null }).kind, "scan");
    assert.equal(planQuery(attendance, { instructor_id: /abc/ }).kind, "scan");
    assert.equal(planQuery(attendance, { $or: [{ instructor_id: "a" }, { instructor_id: "b" }] }).kind, "scan");
    assert.equal(planQuery(attendance, { instructor_id: { $in: ["a", null] } }).kind, "scan");
  });
});

describe("document store (in memory)", () => {
  let db;
  beforeEach(() => {
    db = memoryDatabase();
  });

  test("find supports filters, sort, skip, limit, projection and counts", async () => {
    const people = db.collection("instructors");
    for (const [index, name] of ["Asha", "Bala", "Chitra", "Deepa"].entries()) {
      await people.insertOne({ name, college_id: index < 3 ? "c1" : "c2", rank: index, deleted_at: null });
    }
    const page = await people.find({ college_id: "c1" }).sort({ name: -1 }).skip(1).limit(1).project({ name: 1, _id: 0 }).toArray();
    assert.deepEqual(page, [{ name: "Bala" }]);
    assert.equal(await people.countDocuments({ rank: { $gte: 1 } }), 3);
    assert.deepEqual((await people.distinct("college_id")).sort(), ["c1", "c2"]);
    assert.equal((await people.findOne({ name: "Deepa" })).college_id, "c2");
    assert.equal(await people.findOne({ name: "Nobody" }), null);
  });

  test("indexed lookups never read a whole table", async () => {
    const calls = spy(db);
    const attendance = db.collection("attendance");
    await attendance.insertOne({ instructor_id: "i1", attendance_day: "2026-11-19", college_id: "c1", date: new Date(), check_in_time: new Date() });
    calls.length = 0;
    await attendance.findOne({ instructor_id: "i1" });
    await attendance.find({ college_id: "c1", date: { $gte: new Date(0) } }).toArray();
    await attendance.findOne({ instructor_id: "i1", attendance_day: "2026-11-19" });
    await db.collection("users").findOne({ email: "nobody@example.com" });
    assert.deepEqual(calls.filter((call) => call.name === "scanTable"), []);
  });

  test("one attendance per instructor per day is enforced, and only for string keys", async () => {
    const attendance = db.collection("attendance");
    await attendance.insertOne({ instructor_id: "i1", attendance_day: "2026-11-19" });
    await assert.rejects(
      attendance.insertOne({ instructor_id: "i1", attendance_day: "2026-11-19" }),
      (error) => error.code === 11000 && error.keyPattern.instructor_id === 1 && error.keyPattern.attendance_day === 1
    );
    await attendance.insertOne({ instructor_id: null, attendance_day: "2026-11-19" });
    await attendance.insertOne({ instructor_id: null, attendance_day: "2026-11-19" });
    await attendance.insertOne({ instructor_id: "i1", attendance_day: "2026-11-20" });
  });

  test("changing a unique field frees the old value", async () => {
    const instructors = db.collection("instructors");
    const { insertedId } = await instructors.insertOne({ employee_id: "E1", name: "A" });
    await instructors.updateOne({ _id: insertedId }, { $set: { employee_id: "E2" } });
    await instructors.insertOne({ employee_id: "E1", name: "B" });
    await assert.rejects(instructors.insertOne({ employee_id: "E2", name: "C" }), { code: 11000 });
  });

  test("user emails are unique regardless of case", async () => {
    await db.collection("users").insertOne({ email: "Admin@Example.com" });
    await assert.rejects(db.collection("users").insertOne({ email: "admin@example.COM" }), { code: 11000 });
  });

  test("upserts take equality fields from the filter and apply $setOnInsert only on insert", async () => {
    const settings = db.collection("app_settings");
    const first = await settings.updateOne(
      { _id: "holidays" },
      { $set: { _id: "holidays", days: ["2026-12-25"] }, $setOnInsert: { created_by: "a" } },
      { upsert: true }
    );
    assert.equal(first.upsertedId, "holidays");
    const second = await settings.updateOne(
      { _id: "holidays" },
      { $set: { days: [] }, $setOnInsert: { created_by: "b" } },
      { upsert: true }
    );
    assert.equal(second.matchedCount, 1);
    assert.deepEqual(await settings.findOne({ _id: "holidays" }), { _id: "holidays", days: [], created_by: "a" });
    await assert.rejects(settings.updateOne({ _id: "holidays" }, { $set: { _id: "other" } }), { code: 66 });
  });

  test("an upsert whose filter has no id takes the id from $setOnInsert", async () => {
    // How saveEvaluation stores a new AI result.
    const evaluations = db.collection("evaluations");
    const result = await evaluations.updateOne(
      { attendance_id: "a1", kind: { $ne: "checkout" } },
      { $set: { attendance_id: "a1", overall_status: "COMPLIANT" }, $setOnInsert: { _id: "e1", created_at: new Date() } },
      { upsert: true }
    );
    assert.equal(result.upsertedId, "e1");
    assert.equal((await evaluations.findOne({ attendance_id: "a1" }))._id, "e1");
    await evaluations.updateOne(
      { attendance_id: "a1", kind: { $ne: "checkout" } },
      { $set: { overall_status: "NON_COMPLIANT" }, $setOnInsert: { _id: "e2" } },
      { upsert: true }
    );
    const stored = await evaluations.find({ attendance_id: "a1" }).toArray();
    assert.deepEqual(stored.map((row) => [row._id, row.overall_status]), [["e1", "NON_COMPLIANT"]]);

    const generated = await evaluations.updateOne({ attendance_id: "a2" }, { $set: { kind: "checkout" } }, { upsert: true });
    assert.match(generated.upsertedId, /^[0-9a-f]{24}$/);
  });

  test("an unchanged update is matched but not modified", async () => {
    const { insertedId } = await db.collection("colleges").insertOne({ name: "X", location: "Y" });
    const result = await db.collection("colleges").updateOne({ _id: insertedId }, { $set: { name: "X" } });
    assert.equal(result.matchedCount, 1);
    assert.equal(result.modifiedCount, 0);
  });

  test("concurrent queue claims never hand the same job to two workers", async () => {
    const jobs = db.collection("evaluation_jobs");
    for (let index = 0; index < 3; index += 1) {
      await jobs.insertOne({ status: "queued", available_at: new Date(0), created_at: new Date(index) });
    }
    const claims = await Promise.all(Array.from({ length: 6 }, () => jobs.findOneAndUpdate(
      { status: "queued", available_at: { $lte: new Date() } },
      { $set: { status: "processing" }, $inc: { attempts: 1 } },
      { sort: { created_at: 1 }, returnDocument: "after" }
    )));
    const claimed = claims.filter(Boolean);
    assert.equal(claimed.length, 3);
    assert.equal(new Set(claimed.map((job) => job._id)).size, 3);
    assert.ok(claimed.every((job) => job.status === "processing" && job.attempts === 1));
  });

  test("transactions commit together, see their own writes, and roll back on error", async () => {
    await db.withTransaction(async (session) => {
      await db.collection("boas").insertOne({ _id: "b1", employee_id: "E1", college_id: "c1" }, { session });
      await db.collection("users").insertOne({ _id: "u1", email: "b@x.com", reference_id: "b1" }, { session });
      assert.equal((await db.collection("boas").findOne({ employee_id: "E1" }, { session }))._id, "b1");
      assert.equal(await db.collection("boas").findOne({ _id: "b1" }), null, "not visible outside before commit");
    });
    assert.ok(await db.collection("users").findOne({ email: "b@x.com" }));

    await assert.rejects(db.withTransaction(async (session) => {
      await db.collection("boas").insertOne({ _id: "b2", employee_id: "E2", college_id: "c1" }, { session });
      throw new Error("boom");
    }), /boom/);
    assert.equal(await db.collection("boas").findOne({ _id: "b2" }), null);

    await assert.rejects(db.withTransaction(async (session) => {
      await db.collection("boas").insertOne({ employee_id: "E1", college_id: "c2" }, { session });
    }), { code: 11000 });
  });

  test("a transaction that loses a race is retried against fresh data", async () => {
    const colleges = db.collection("colleges");
    await colleges.insertOne({ _id: "c1", name: "A", location: "L", seats: 0 });
    let attempts = 0;
    await db.withTransaction(async (session) => {
      attempts += 1;
      const college = await colleges.findOne({ _id: "c1" }, { session });
      if (attempts === 1) await colleges.updateOne({ _id: "c1" }, { $inc: { seats: 10 } });
      await colleges.updateOne({ _id: "c1" }, { $set: { seats: college.seats + 1 } }, { session });
    });
    assert.equal(attempts, 2);
    assert.equal((await colleges.findOne({ _id: "c1" })).seats, 11);
  });

  test("a unique value can move between two documents in one transaction", async () => {
    const instructors = db.collection("instructors");
    await instructors.insertOne({ _id: "a", employee_id: "E1" });
    await db.withTransaction(async (session) => {
      await instructors.updateOne({ _id: "a" }, { $set: { employee_id: "E9" } }, { session });
      await instructors.insertOne({ _id: "b", employee_id: "E1" }, { session });
    });
    assert.equal((await instructors.findOne({ employee_id: "E1" }))._id, "b");
    assert.equal((await instructors.findOne({ employee_id: "E9" }))._id, "a");
  });

  test("expired documents behave as already deleted, including their unique keys", async () => {
    let now = Date.parse("2026-11-19T00:00:00Z");
    db = memoryDatabase({ now: () => now });
    const resets = db.collection("password_resets");
    await resets.insertOne({ _id: "r1", email: "a@x.com", token_hash: "h1", expires_at: new Date(now + 1000) });
    assert.ok(await resets.findOne({ token_hash: "h1" }));
    now += 5000;
    assert.equal(await resets.findOne({ token_hash: "h1" }), null);
    await resets.insertOne({ _id: "r1", email: "a@x.com", token_hash: "h2", expires_at: new Date(now + 1000) });
    await resets.insertOne({ _id: "r2", email: "b@x.com", token_hash: "h1", expires_at: new Date(now + 1000) });
    assert.equal((await resets.findOne({ token_hash: "h1" }))._id, "r2");
  });

  test("aggregation pipelines run on the matched documents", async () => {
    const attendance = db.collection("attendance");
    const day = new Date("2026-11-19T04:00:00Z");
    await attendance.insertMany([
      { instructor_id: "a", attendance_day: "2026-11-19", date: day, status: "compliant" },
      { instructor_id: "b", attendance_day: "2026-11-19", date: day, status: "non_compliant" },
      { instructor_id: "c", attendance_day: "2026-11-18", date: new Date("2026-11-18T04:00:00Z"), status: "compliant" },
    ]);
    const rows = await attendance.aggregate([
      { $match: { date: { $gte: new Date("2026-11-19T00:00:00Z") } } },
      { $group: { _id: { $dateToString: { date: "$date", format: "%Y-%m-%d", timezone: "Asia/Kolkata" } }, n: { $sum: 1 } } },
    ]).toArray();
    assert.deepEqual(rows, [{ _id: "2026-11-19", n: 2 }]);
  });

  test("bulkWrite reports counts like the driver", async () => {
    const result = await db.collection("instructors").bulkWrite([
      { updateOne: { filter: { instructor_user_id: "u1" }, update: { $set: { name: "A" } }, upsert: true } },
      { updateOne: { filter: { instructor_user_id: "u1" }, update: { $set: { name: "B" } }, upsert: true } },
      { insertOne: { document: { name: "C" } } },
    ], { ordered: false });
    assert.equal(result.upsertedCount, 1);
    assert.equal(result.modifiedCount, 1);
    assert.equal(result.insertedCount, 1);
  });

  test("simultaneous check-ins for one instructor and day record exactly one", async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => db.withTransaction(async (session) => {
      const existing = await db.collection("attendance").findOne({ instructor_id: "i1", attendance_day: "2026-11-19" }, { session });
      if (existing) return "already";
      await db.collection("attendance").insertOne({ _id: `a${index}`, instructor_id: "i1", attendance_day: "2026-11-19" }, { session });
      return "recorded";
    })));
    const recorded = outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value === "recorded");
    assert.equal(recorded.length, 1);
    assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled" || outcome.reason.code === 11000));
    assert.equal(await db.collection("attendance").countDocuments({ instructor_id: "i1" }), 1);
  });

  test("simultaneous increments are never lost", async () => {
    await db.collection("colleges").insertOne({ _id: "c1", name: "A", location: "L", n: 0 });
    await Promise.all(Array.from({ length: 20 }, () => db.collection("colleges").updateOne({ _id: "c1" }, { $inc: { n: 1 } })));
    assert.equal((await db.collection("colleges").findOne({ _id: "c1" })).n, 20);
  });

  test("unknown collections fail loudly instead of silently", () => {
    assert.throws(() => db.collection("not_a_collection"), { code: "UNKNOWN_COLLECTION" });
  });

  test("migration copies everything, is safe to repeat, and verifies every unique guard", async () => {
    const source = memoryDatabase();
    await source.collection("instructors").insertOne({ _id: newDocumentId(), employee_id: "E1", report_token: "t1" });
    await source.collection("attendance").insertOne({ instructor_id: "i1", attendance_day: "2026-11-19", date: new Date() });
    const collections = ["instructors", "attendance"];
    const first = await copyCollections(source, db, { collections });
    assert.deepEqual(first.map((row) => row.written), [1, 1]);
    const again = await copyCollections(source, db, { collections });
    assert.deepEqual(again.map((row) => row.unchanged), [1, 1]);
    const report = await verifyCollections(source, db, { collections });
    assert.ok(report.every((row) => row.ok && row.bad_guards === 0));
    assert.equal(report[0].unique_guards, 2);

    await source.collection("attendance").deleteMany({});
    assert.equal((await verifyCollections(source, db, { collections: ["attendance"] }))[0].extra, 1);
    const pruned = await copyCollections(source, db, { collections: ["attendance"], prune: true });
    assert.equal(pruned[0].removed, 1);
    assert.equal(await db.collection("attendance").countDocuments({}), 0);
    assert.equal((await verifyCollections(source, db, { collections: ["attendance"] }))[0].extra, 0);
  });
});

describe("write requests", () => {
  test("transaction items use exactly the single-write request shape", () => {
    const put = { op: "put", table: "t", item: { _id: "a" }, condition: { absent: "_id" } };
    const remove = { op: "delete", table: "t", key: { name: "_id", value: "a" }, condition: { equals: { attr: "v", value: 2 } } };
    assert.deepEqual(actionRequest(put), {
      Put: {
        TableName: "t",
        Item: { _id: "a" },
        ConditionExpression: "attribute_not_exists(#key)",
        ExpressionAttributeNames: { "#key": "_id" },
      },
    });
    assert.equal(actionRequest(remove).Delete.ConditionExpression, "#attr = :value");
  });

  test("every collection table has a valid definition", () => {
    for (const name of COLLECTION_NAMES) {
      const definition = tableDefinition(PREFIX, name);
      assert.equal(definition.BillingMode, "PAY_PER_REQUEST");
      for (const index of definition.GlobalSecondaryIndexes || []) {
        for (const key of index.KeySchema) {
          assert.ok(definition.AttributeDefinitions.some((attribute) => attribute.AttributeName === key.AttributeName));
        }
      }
    }
  });

  test("applyUpdate refuses to change _id", () => {
    assert.throws(() => applyUpdate({ _id: "a" }, { $set: { _id: "b" } }), { code: 66 });
  });
});

// The same store against a DynamoDB-compatible server (dynalite). dynalite has
// no TransactWriteItems, so multi-item writes run one request at a time here;
// that checks every request DynamoDB will receive, while atomicity is covered
// by the in-memory tests above.
describe("document store against dynalite", () => {
  let server;
  let rawClient;
  let db;
  const saved = {};

  class SequentialDriver extends AwsDynamoDriver {
    async write(actions) {
      if (actions.length <= 1) return super.write(actions);
      for (const [index, action] of actions.entries()) {
        try {
          await super.write([action]);
        } catch (error) {
          if (error instanceof ConditionFailedError) throw new ConditionFailedError(index);
          throw error;
        }
      }
    }
  }

  before(async () => {
    for (const key of ["DYNAMODB_ENDPOINT", "DYNAMODB_REGION", "DYNAMODB_ACCESS_KEY_ID", "DYNAMODB_SECRET_ACCESS_KEY"]) {
      saved[key] = process.env[key];
    }
    server = dynalite({ createTableMs: 0, updateTableMs: 0 });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.DYNAMODB_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
    process.env.DYNAMODB_REGION = "ap-south-1";
    rawClient = createDynamoClient();
    const driver = new SequentialDriver(rawClient);
    driver.enableTtl = async () => {};
    driver.ttlEnabled = async () => true;
    const report = await ensureTables(driver, "dyn-", { apply: true, pointInTimeRecovery: false });
    assert.ok(report.every((entry) => entry.actions.includes("created")));
    db = new DynamoDocumentDatabase({ driver, tablePrefix: "dyn-" });
  });

  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rawClient.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  test("reads and writes go through real DynamoDB requests", async () => {
    const attendance = db.collection("attendance");
    const checkIn = new Date("2026-11-19T03:30:00Z");
    const { insertedId } = await attendance.insertOne({
      instructor_id: "i1", attendance_day: "2026-11-19", college_id: "c1", date: checkIn, check_in_time: checkIn,
    });
    await attendance.insertOne({ instructor_id: "i2", attendance_day: "2026-11-19", college_id: "c1", date: checkIn, check_in_time: checkIn });
    assert.equal((await attendance.findOne({ instructor_id: "i1" }))._id, insertedId);
    assert.equal((await attendance.find({ college_id: "c1", date: { $gte: new Date("2026-11-19T00:00:00Z") } }).toArray()).length, 2);
    assert.equal((await attendance.findOne({ instructor_id: "i1", attendance_day: "2026-11-19" }))._id, insertedId);
    await assert.rejects(attendance.insertOne({ instructor_id: "i1", attendance_day: "2026-11-19" }), { code: 11000 });
    await attendance.updateOne({ _id: insertedId }, { $set: { _private_evaluation_outbox: { created_at: new Date() } } });
    assert.equal((await attendance.findOne({ _private_evaluation_outbox: { $exists: true } }))._id, insertedId);
    assert.equal((await attendance.deleteOne({ _id: insertedId })).deletedCount, 1);
    await attendance.insertOne({ instructor_id: "i1", attendance_day: "2026-11-19" });
    assert.equal(await attendance.countDocuments({}), 2);
    await db.withTransaction(async (session) => {
      await db.collection("users").insertOne({ email: "t@x.com" }, { session });
      await db.collection("boas").insertOne({ employee_id: "B1", college_id: "c1" }, { session });
    });
    assert.ok(await db.collection("boas").findOne({ college_id: "c1" }));
    assert.equal((await db.command({ ping: 1 })).ok, 1);
  });
});
