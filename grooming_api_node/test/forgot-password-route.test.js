import assert from "node:assert/strict";
import { after, test } from "node:test";
import express from "express";
import { authRouter } from "../src/routes/authRoutes.js";
import { openSecret } from "../src/services/secretBox.js";
import { hashResetToken } from "../src/services/passwordResetService.js";

/**
 * Exercises the endpoint over HTTP rather than the service beneath it.
 *
 * password-reset.test.js covered issueResetToken thoroughly and passed the
 * whole time the route was answering 500: the handler referenced a constant
 * declared inside a different handler's closure, which is a runtime error that
 * no import check and no service-level test can see. Self-service password
 * reset was therefore broken in production with a green suite. These tests go
 * through the router so that failure mode is observable.
 */

/** In-memory stand-in for the collections this route touches. */
function fakeDb() {
  const store = new Map([
    ["users", []],
    ["password_resets", []],
    ["mail_jobs", []],
    ["boas", []],
  ]);
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && "$in" in value) return value.$in.includes(row[key]);
    return row[key] === value;
  });
  return {
    rows: (name) => store.get(name),
    collection(name) {
      if (!store.has(name)) store.set(name, []);
      const rows = () => store.get(name);
      return {
        async findOne(filter) {
          return rows().find((row) => matches(row, filter)) || null;
        },
        async updateOne(filter, update, options = {}) {
          const row = rows().find((item) => matches(item, filter));
          if (!row) {
            if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 };
            const created = { ...filter, ...(update.$setOnInsert || {}), ...(update.$set || {}) };
            rows().push(created);
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
          }
          Object.assign(row, update.$set || {});
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async deleteMany() {
          return { deletedCount: 0 };
        },
      };
    },
  };
}

function startServer(db) {
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use("/api/v2/auth", authRouter);
  const server = app.listen(0);
  const { port } = server.address();
  return {
    server,
    post: async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

const servers = [];
const openServer = (db) => {
  const handle = startServer(db);
  servers.push(handle.server);
  return handle;
};
after(() => servers.forEach((server) => server.close()));

test("a reset request for a known address succeeds and queues one job", async () => {
  const db = fakeDb();
  db.rows("users").push({
    _id: "u1",
    email: "boa@example.com",
    role: "BOA",
    name: "Asha",
    password_hash: "x",
  });
  const { post } = openServer(db);

  const { status, body } = await post("/api/v2/auth/forgot-password", { email: "boa@example.com" });

  assert.equal(status, 200, "the handler must not throw");
  assert.match(body.message, /reset link/i);
  assert.equal(db.rows("mail_jobs").length, 1);
  assert.equal(db.rows("mail_jobs")[0].type, "password_reset");
});

test("an unknown address gets the same answer and queues nothing", async () => {
  const db = fakeDb();
  const { post } = openServer(db);

  const known = await post("/api/v2/auth/forgot-password", { email: "nobody@example.com" });
  const blank = await post("/api/v2/auth/forgot-password", { email: "" });

  assert.equal(known.status, 200);
  assert.equal(blank.status, 200);
  // Identical bodies, or the endpoint enumerates which addresses hold accounts.
  assert.deepEqual(known.body, blank.body);
  assert.equal(db.rows("mail_jobs").length, 0);
});

test("a disabled account is never sent a link", async () => {
  const db = fakeDb();
  db.rows("users").push({
    _id: "u1",
    email: "gone@example.com",
    role: "BOA",
    disabled_at: new Date(),
  });
  const { post } = openServer(db);

  const { status } = await post("/api/v2/auth/forgot-password", { email: "gone@example.com" });

  assert.equal(status, 200);
  assert.equal(db.rows("mail_jobs").length, 0);
});

test("the queued job carries a sealed token, never the raw one", async () => {
  const db = fakeDb();
  db.rows("users").push({ _id: "u1", email: "boa@example.com", role: "BOA", name: "Asha" });
  const { post } = openServer(db);

  await post("/api/v2/auth/forgot-password", { email: "boa@example.com" });

  const job = db.rows("mail_jobs")[0];
  assert.equal(job.payload.token, undefined, "the raw token must not sit in the queue");
  assert.ok(job.payload.token_sealed, "the job needs a sealed token to send the email");

  // The sealed value must open to a token that matches the stored hash, or the
  // link in the email would not be redeemable.
  const opened = openSecret(job.payload.token_sealed);
  assert.equal(hashResetToken(opened), db.rows("password_resets")[0].token_hash);
  assert.notEqual(job.payload.token_sealed, opened);
});
