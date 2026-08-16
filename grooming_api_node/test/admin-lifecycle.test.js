import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deleteBoaGuarded,
  deleteCollegeGuarded,
  listActiveBoasWithAccounts,
  serializeAdminDocument,
  updateBoaGuarded,
} from "../src/routes/adminRoutes.js";
import { boaUpdateSchema } from "../src/validation.js";

function transactionRunner(session) {
  return async (work) => work(session);
}

test("BOA update atomically changes profile/account and revokes existing sessions", async () => {
  const session = { id: "boa-update" };
  const boa = { _id: "boa-1", employee_id: "EMP-1", college_id: "college-1" };
  const user = {
    _id: "user-1",
    email: "old@example.com",
    role: "BOA",
    reference_id: boa._id,
    session_version: 2,
  };
  const updates = [];
  let boaReads = 0;
  let userReads = 0;
  const db = {
    collection(name) {
      if (name === "boas") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          boaReads += 1;
          return boaReads === 1 ? boa : null;
        },
        updateOne: async (_query, update, options) => {
          assert.equal(options.session, session);
          updates.push({ name, update });
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
      if (name === "users") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          userReads += 1;
          return userReads === 1 ? user : null;
        },
        updateOne: async (_query, update, options) => {
          assert.equal(options.session, session);
          updates.push({ name, update });
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
      if (name === "colleges") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          return { _id: "college-2" };
        },
        updateOne: async (_query, update, options) => {
          assert.equal(options.session, session);
          assert.equal(update.$inc._private_assignment_guard_version, 1);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };

  const result = await updateBoaGuarded(
    db,
    boa._id,
    {
      employee_id: "EMP-2",
      name: "Updated BOA",
      email: "updated@example.com",
      college_id: "college-2",
    },
    "new-password-hash",
    transactionRunner(session)
  );

  assert.equal(result.outcome, "updated");
  const boaUpdate = updates.find((entry) => entry.name === "boas").update;
  assert.equal(boaUpdate.$set.college_id, "college-2");
  assert.equal(boaUpdate.$set.email, "updated@example.com");
  const userUpdate = updates.find((entry) => entry.name === "users").update;
  assert.equal(userUpdate.$set.password_hash, "new-password-hash");
  assert.equal(userUpdate.$inc.session_version, 1);
});

test("BOA deletion soft-disables both records and revokes the account session", async () => {
  const session = { id: "boa-delete" };
  const updates = [];
  const db = {
    collection(name) {
      if (name === "boas") return {
        findOne: async () => ({ _id: "boa-2" }),
        updateOne: async (_query, update, options) => {
          assert.equal(options.session, session);
          updates.push({ name, update });
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
      if (name === "users") return {
        findOne: async () => ({ _id: "user-2", role: "BOA", reference_id: "boa-2" }),
        updateOne: async (_query, update, options) => {
          assert.equal(options.session, session);
          updates.push({ name, update });
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };

  const result = await deleteBoaGuarded(db, "boa-2", transactionRunner(session));
  assert.equal(result.outcome, "deleted");
  assert.ok(updates.find((entry) => entry.name === "boas").update.$set.deleted_at instanceof Date);
  const userUpdate = updates.find((entry) => entry.name === "users").update;
  assert.ok(userUpdate.$set.disabled_at instanceof Date);
  assert.equal(userUpdate.$inc.session_version, 1);
});

test("college deletion returns a conflict outcome while an active BOA is assigned", async () => {
  const session = { id: "college-conflict" };
  let collegeUpdates = 0;
  const db = {
    collection(name) {
      if (name === "colleges") return {
        findOne: async () => ({ _id: "college-3" }),
        updateOne: async () => {
          collegeUpdates += 1;
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
      if (name === "boas") return { findOne: async () => ({ _id: "boa-3" }) };
      throw new Error(`Unexpected collection ${name}`);
    },
  };

  const result = await deleteCollegeGuarded(db, "college-3", transactionRunner(session));
  assert.equal(result.outcome, "assigned_boa");
  assert.equal(collegeUpdates, 0);
});

test("college deletion returns a conflict outcome while an active instructor is assigned", async () => {
  const session = { id: "college-instructor-conflict" };
  let collegeUpdates = 0;
  const db = {
    collection(name) {
      if (name === "colleges") return {
        findOne: async () => ({ _id: "college-instructor-1" }),
        updateOne: async () => {
          collegeUpdates += 1;
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
      if (name === "boas") return { findOne: async () => null };
      if (name === "instructors") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          return { _id: "instructor-1" };
        },
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };

  const result = await deleteCollegeGuarded(
    db,
    "college-instructor-1",
    transactionRunner(session)
  );
  assert.equal(result.outcome, "assigned_instructor");
  assert.equal(collegeUpdates, 0);
});

test("unassigned college deletion is a soft delete in one transaction", async () => {
  const session = { id: "college-delete" };
  let deleteUpdate;
  const db = {
    collection(name) {
      if (name === "colleges") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          return { _id: "college-4" };
        },
        updateOne: async (_query, update, options) => {
          assert.equal(options.session, session);
          deleteUpdate = update;
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
      if (name === "boas" || name === "instructors") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          return null;
        },
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };

  const result = await deleteCollegeGuarded(db, "college-4", transactionRunner(session));
  assert.equal(result.outcome, "deleted");
  assert.ok(deleteUpdate.$set.deleted_at instanceof Date);
});

test("BOA update accepts an omitted or blank password as unchanged and private guards are redacted", () => {
  const omitted = boaUpdateSchema.parse({
    employee_id: "EMP-5",
    name: "BOA Name",
    email: "BOA@Example.com",
    college_id: "college-5",
  });
  assert.equal(omitted.password, undefined);
  assert.equal(omitted.email, "boa@example.com");

  const parsed = boaUpdateSchema.parse({
    employee_id: "EMP-5",
    name: "BOA Name",
    email: "BOA@Example.com",
    password: "",
    college_id: "college-5",
  });
  assert.equal(parsed.password, undefined);
  assert.equal(parsed.email, "boa@example.com");
  assert.equal(boaUpdateSchema.safeParse({ ...parsed, password: "short" }).success, false);
  assert.deepEqual(
    serializeAdminDocument({
      _id: "college-5",
      name: "College",
      _private_assignment_guard_version: 9,
      _private_college_guard_version: 10,
    }),
    { _id: "college-5", name: "College" }
  );
});

test("BOA list excludes active profiles whose user account is disabled or missing", async () => {
  const boas = [
    { _id: "boa-active", name: "Active" },
    { _id: "boa-disabled", name: "Disabled" },
    { _id: "boa-missing", name: "Missing" },
  ];
  const db = {
    collection(name) {
      if (name === "boas") return {
        find: () => ({
          limit() { return this; },
          toArray: async () => boas,
        }),
      };
      if (name === "users") return {
        find(query) {
          assert.equal(query.$and[0].role, "BOA");
          assert.ok(query.$and[0].reference_id.$in.includes("boa-active"));
          return {
            project() { return this; },
            limit() { return this; },
            toArray: async () => [{ reference_id: "boa-active" }],
          };
        },
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };

  assert.deepEqual(await listActiveBoasWithAccounts(db), [boas[0]]);
});
