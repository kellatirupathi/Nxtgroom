import assert from "node:assert/strict";
import { after, test } from "node:test";
import express from "express";
import { reportRouter } from "../src/routes/reportRoutes.js";

const CRON_SECRET = "test-cron-secret-value";

function fakeDb(records) {
  const rows = records.map((row) => ({ ...row }));
  const queries = [];
  return {
    rows,
    queries,
    collection(name) {
      assert.equal(name, "attendance");
      return {
        find(filter) {
          queries.push(filter);
          const excluded = new Set(filter._id?.$nin || []);
          const matching = rows.filter((row) => (
            !excluded.has(row._id)
            && row.check_in_time < filter.check_in_time.$lt
            && (typeof row.check_in_photo_key === "string"
              || typeof row.check_out_photo_key === "string")
          ));
          return {
            limit: (count) => ({ toArray: async () => matching.slice(0, count) }),
            toArray: async () => matching,
          };
        },
        async updateOne(filter, update) {
          const row = rows.find((item) => item._id === filter._id);
          if (row) Object.assign(row, update.$set || {});
          return { matchedCount: row ? 1 : 0 };
        },
      };
    },
  };
}

function startServer(db) {
  const app = express();
  app.locals.db = db;
  app.use("/api/v2/reports", reportRouter);
  const server = app.listen(0);
  const { port } = server.address();
  return {
    server,
    purge: async (query = "") => {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v2/reports/cron/purge-photos${query}`,
        { method: "POST", headers: { "x-cron-secret": CRON_SECRET } }
      );
      return { status: response.status, body: await response.json() };
    },
  };
}

const servers = [];
after(() => servers.forEach((server) => server.close()));
const openServer = (db) => {
  const handle = startServer(db);
  servers.push(handle.server);
  return handle;
};

const expired = (index) => ({
  _id: `a${index}`,
  check_in_time: new Date("2020-01-01T00:00:00.000Z"),
  check_in_photo_key: `attendance/2020/01/01/${index}-checkin.jpg`,
});

test("a backlog larger than one batch is worked through in a single run", async (t) => {
  t.after(() => { delete process.env.CRON_SECRET; });
  process.env.CRON_SECRET = CRON_SECRET;
  const db = fakeDb(Array.from({ length: 250 }, (_, index) => expired(index)));
  const { purge } = openServer(db);

  const { status, body } = await purge();

  assert.equal(status, 200);
  assert.equal(body.records, 250, "every expired record must be visited, not just the first 200");
  assert.equal(body.more, false, "the backlog was cleared, so the caller must not be told to run again");
});

test("records whose object cannot be deleted are not read again", async (t) => {
  t.after(() => { delete process.env.CRON_SECRET; });
  process.env.CRON_SECRET = CRON_SECRET;
  const db = fakeDb(Array.from({ length: 250 }, (_, index) => expired(index)));
  const { purge } = openServer(db);

  const { body } = await purge();

  assert.equal(body.photos_failed, 250);
  assert.equal(body.photos_deleted, 0);
  assert.equal(db.queries.length, 2);
  assert.deepEqual(db.queries[1]._id.$nin.length, 200);
});

test("a failed delete leaves the key on the record for the next run", async (t) => {
  t.after(() => { delete process.env.CRON_SECRET; });
  process.env.CRON_SECRET = CRON_SECRET;
  const db = fakeDb([expired(0)]);
  const { purge } = openServer(db);

  await purge();

  assert.equal(db.rows[0].check_in_photo_key, "attendance/2020/01/01/0-checkin.jpg");
  assert.equal(db.rows[0].photos_purged_at, undefined);
});

test("a dry run reports the backlog without touching anything", async (t) => {
  t.after(() => { delete process.env.CRON_SECRET; });
  process.env.CRON_SECRET = CRON_SECRET;
  const db = fakeDb(Array.from({ length: 5 }, (_, index) => expired(index)));
  const { purge } = openServer(db);

  const { body } = await purge("?dry=1");

  assert.equal(body.dry_run, true);
  assert.equal(body.records, 5);
  assert.equal(body.photos, 5, "a dry run reports what it would remove");
  assert.equal(db.rows[0].check_in_photo_key, "attendance/2020/01/01/0-checkin.jpg");
  assert.equal(db.queries.length, 1, "a dry run must not walk the whole backlog");
});

test("the endpoint still refuses a caller without the shared secret", async (t) => {
  t.after(() => { delete process.env.CRON_SECRET; });
  process.env.CRON_SECRET = CRON_SECRET;
  const db = fakeDb([expired(0)]);
  const handle = openServer(db);
  const response = await fetch(
    `http://127.0.0.1:${handle.server.address().port}/api/v2/reports/cron/purge-photos`,
    { method: "POST" }
  );

  assert.equal(response.status, 401);
});
