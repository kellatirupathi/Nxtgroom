import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consumeResetToken,
  hashResetToken,
  issueResetToken,
  peekResetToken,
  RESET_COLLECTION,
} from "../src/services/passwordResetService.js";
import { appUrl } from "../src/config/env.js";

/** In-memory stand-in for the one collection this service touches. */
function fakeDb() {
  let rows = [];
  return {
    __rows: () => rows,
    collection(name) {
      assert.equal(name, RESET_COLLECTION);
      return {
        async updateOne(filter, update, options = {}) {
          let row = rows.find((item) => item.email === filter.email);
          if (!row && options.upsert) {
            row = { ...(update.$setOnInsert || {}), _id: `id-${rows.length + 1}` };
            rows.push(row);
          }
          if (!row) return { matchedCount: 0, modifiedCount: 0 };
          Object.assign(row, update.$set || {});
          return { matchedCount: 1, modifiedCount: 1, upsertedCount: options.upsert ? 1 : 0 };
        },
        async insertOne(doc) {
          rows.push({ ...doc, _id: `id-${rows.length + 1}` });
          return { insertedId: `id-${rows.length}` };
        },
        async findOne(filter) {
          return rows.find((row) => row.token_hash === filter.token_hash) || null;
        },
        async deleteMany(filter) {
          const before = rows.length;
          rows = rows.filter((row) => row.email !== filter.email);
          return { deletedCount: before - rows.length };
        },
        async deleteOne(filter) {
          const index = rows.findIndex((row) => row._id === filter._id);
          if (index === -1) return { deletedCount: 0 };
          rows.splice(index, 1);
          return { deletedCount: 1 };
        },
      };
    },
  };
}

test("the raw token is never stored, only its hash", async () => {
  const db = fakeDb();
  const token = await issueResetToken(db, {
    email: "Person@Example.com",
    kind: "invite",
    ttlMs: 60_000,
  });

  const [row] = db.__rows();
  assert.equal(row.token_hash, hashResetToken(token));
  assert.notEqual(row.token_hash, token);
  assert.equal(
    JSON.stringify(db.__rows()).includes(token),
    false,
    "a database dump must not contain a replayable token",
  );
  assert.equal(row.email, "person@example.com", "email is normalised for lookup");
});

test("a token works once and is refused on reuse", async () => {
  const db = fakeDb();
  const token = await issueResetToken(db, {
    email: "a@example.com",
    kind: "reset",
    ttlMs: 60_000,
  });

  const first = await consumeResetToken(db, token);
  assert.equal(first.email, "a@example.com");
  assert.equal(first.error, undefined);

  const second = await consumeResetToken(db, token);
  assert.equal(second.error, "invalid", "a redeemed link must not work twice");
});

test("issuing a new token invalidates the previous one", async () => {
  const db = fakeDb();
  const older = await issueResetToken(db, { email: "b@example.com", kind: "reset", ttlMs: 60_000 });
  const newer = await issueResetToken(db, { email: "b@example.com", kind: "reset", ttlMs: 60_000 });

  assert.equal((await consumeResetToken(db, older)).error, "invalid", "a forwarded old email is dead");
  assert.equal((await consumeResetToken(db, newer)).email, "b@example.com");
});

test("expired tokens are refused and cleaned up", async () => {
  const db = fakeDb();
  const token = await issueResetToken(db, { email: "c@example.com", kind: "reset", ttlMs: -1000 });

  assert.equal((await peekResetToken(db, token)).error, "expired");
  assert.equal((await consumeResetToken(db, token)).error, "expired");
  assert.deepEqual(db.__rows(), [], "the expired row is removed");
});

test("garbage input is rejected without touching the database", async () => {
  const db = fakeDb();
  for (const value of ["", null, undefined, 42, {}]) {
    assert.equal((await consumeResetToken(db, value)).error, "invalid");
    assert.equal((await peekResetToken(db, value)).error, "invalid");
  }
});

test("email links only ever point at an allowlisted origin", () => {
  const originalCors = process.env.CORS_ORIGINS;
  const originalApp = process.env.APP_URL;
  try {
    process.env.CORS_ORIGINS = "https://app.example.com,http://localhost:5173";

    process.env.APP_URL = "https://evil.example.net";
    assert.equal(appUrl(), "https://app.example.com", "an unlisted APP_URL is ignored");

    process.env.APP_URL = "https://app.example.com";
    assert.equal(appUrl(), "https://app.example.com");

    delete process.env.APP_URL;
    assert.equal(appUrl(), "https://app.example.com", "https origin is preferred");
  } finally {
    if (originalCors === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = originalCors;
    if (originalApp === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalApp;
  }
});
