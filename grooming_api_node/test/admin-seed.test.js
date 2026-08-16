import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { seedAdmin } from "../server.js";
import { getPasswordHash, verifyPassword } from "../src/middleware/auth.js";

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnvironment)) delete process.env[name];
  }
  Object.assign(process.env, originalEnvironment);
});

function matches(document, query) {
  return Object.entries(query).every(([key, expected]) => {
    const actual = document[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$exists" in expected) return (actual !== undefined) === expected.$exists;
      if ("$ne" in expected) return actual !== expected.$ne;
    }
    return actual === expected;
  });
}

function fakeDb(initialUsers) {
  const users = initialUsers.map((user) => ({ ...user }));
  return {
    users,
    collection(name) {
      assert.equal(name, "users");
      return {
        findOne: async (query) => users.find((user) => matches(user, query)) || null,
        insertOne: async (document) => {
          users.push({ ...document });
          return { insertedId: document._id };
        },
        updateOne: async (query, update) => {
          const user = users.find((candidate) => matches(candidate, query));
          if (!user) return { matchedCount: 0, modifiedCount: 0 };
          Object.assign(user, update.$set || {});
          for (const [key, increment] of Object.entries(update.$inc || {})) {
            user[key] = (user[key] || 0) + increment;
          }
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
    },
  };
}

test("legacy default administrator is adopted and password-rotated once", async () => {
  process.env.ADMIN_EMAIL = "production-admin@example.com";
  process.env.ADMIN_PASSWORD = "safe-test-password-123";
  process.env.ADMIN_PASSWORD_VERSION = "production-v1";
  const db = fakeDb([{
    _id: "legacy-admin",
    email: "admin@nxtwave.com",
    password_hash: await getPasswordHash("admin@123"),
    role: "SUPER_ADMIN",
  }]);

  await seedAdmin(db);
  assert.equal(db.users.length, 1);
  assert.equal(db.users[0].email, "production-admin@example.com");
  assert.equal(db.users[0].password_version, "production-v1");
  assert.equal(db.users[0].session_version, 1);
  assert.equal(await verifyPassword("safe-test-password-123", db.users[0].password_hash), true);
  assert.equal(await verifyPassword("admin@123", db.users[0].password_hash), false);

  await seedAdmin(db);
  assert.equal(db.users[0].session_version, 1);
});

test("administrator password version rotation revokes previously issued sessions", async () => {
  process.env.ADMIN_EMAIL = "production-admin@example.com";
  process.env.ADMIN_PASSWORD = "new-safe-test-password-123";
  process.env.ADMIN_PASSWORD_VERSION = "production-v2";
  const db = fakeDb([{
    _id: "managed-admin",
    email: "production-admin@example.com",
    password_hash: await getPasswordHash("old-safe-test-password-123"),
    password_version: "production-v1",
    session_version: 4,
    role: "SUPER_ADMIN",
  }]);

  await seedAdmin(db);
  assert.equal(db.users[0].password_version, "production-v2");
  assert.equal(db.users[0].session_version, 5);
  assert.equal(await verifyPassword("new-safe-test-password-123", db.users[0].password_hash), true);
});

test("an unknown unversioned administrator is not silently overwritten", async () => {
  process.env.ADMIN_EMAIL = "production-admin@example.com";
  process.env.ADMIN_PASSWORD = "safe-test-password-123";
  process.env.ADMIN_PASSWORD_VERSION = "production-v1";
  const db = fakeDb([{
    _id: "unknown-admin",
    email: "owner@example.com",
    password_hash: await getPasswordHash("unrelated-password"),
    role: "SUPER_ADMIN",
  }]);

  await assert.rejects(
    () => seedAdmin(db),
    /must be migrated or disabled manually/
  );
  assert.equal(db.users.find((user) => user._id === "unknown-admin").email, "owner@example.com");
});

test("startup fails clearly when the configured administrator is disabled", async () => {
  process.env.ADMIN_EMAIL = "production-admin@example.com";
  process.env.ADMIN_PASSWORD = "safe-test-password-123";
  process.env.ADMIN_PASSWORD_VERSION = "production-v1";
  const db = fakeDb([{
    _id: "disabled-admin",
    email: "production-admin@example.com",
    password_hash: await getPasswordHash("safe-test-password-123"),
    password_version: "production-v1",
    role: "SUPER_ADMIN",
    disabled_at: new Date(),
  }]);

  await assert.rejects(() => seedAdmin(db), /account is disabled/);
});
