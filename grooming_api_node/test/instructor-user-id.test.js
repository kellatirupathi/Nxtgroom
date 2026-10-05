import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { instructorSchema } from "../src/validation.js";
import {
  createInstructorGuarded,
  generateInstructorUserId,
  updateInstructorGuarded,
} from "../src/routes/instructorRoutes.js";

const run = async (work) => work({});
const base = { name: "Ravi Teja", role: "INSTRUCTOR", gender: "MALE", college_id: "c1", email: "ravi@x.in" };

function fakeDb({ existing = null, takenUserIds = [] } = {}) {
  const state = { inserted: null, set: null };
  const db = {
    collection(name) {
      if (name === "colleges") return {
        findOne: async () => ({ _id: "c1" }),
        updateOne: async () => ({ matchedCount: 1 }),
      };
      if (name === "instructors") return {
        findOne: async (filter) => {
          if ("instructor_user_id" in filter) {
            return takenUserIds.includes(filter.instructor_user_id) ? { _id: "someone-else" } : null;
          }
          if ("employee_id" in filter) return null;
          return existing;
        },
        insertOne: async (document) => { state.inserted = document; return { insertedId: document._id }; },
        updateOne: async (_filter, update) => { state.set = update.$set; return { matchedCount: 1 }; },
      };
      if (name === "attendance") return { findOne: async () => null };
      throw new Error(`unexpected ${name}`);
    },
  };
  return { db, state };
}

test("a generated User ID is 32 lowercase hex characters, like the roster's, and never repeats", () => {
  const ids = new Set(Array.from({ length: 200 }, generateInstructorUserId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test("the User ID is optional; a typed one may use letters, numbers, - and _", () => {
  const parse = (value) => instructorSchema.safeParse({ ...base, instructor_user_id: value });
  assert.equal(parse("").data.instructor_user_id, undefined);
  assert.equal(parse("   ").data.instructor_user_id, undefined);
  assert.equal(parse(undefined).data.instructor_user_id, undefined);
  assert.equal(parse(" 3f2a9c_user-01 ").data.instructor_user_id, "3f2a9c_user-01");
  assert.equal(parse("has space").success, false);
  assert.equal(parse("ab").success, false);
  assert.equal(parse("x".repeat(65)).success, false);
});

test("adding without a User ID generates one; a typed one is kept unless it is taken", async () => {
  const blank = fakeDb();
  const created = await createInstructorGuarded(blank.db, { ...base }, run);
  assert.equal(created.outcome, "created");
  assert.match(blank.state.inserted.instructor_user_id, /^[0-9a-f]{32}$/);

  const typed = fakeDb();
  await createInstructorGuarded(typed.db, { ...base, instructor_user_id: "roster-user-42" }, run);
  assert.equal(typed.state.inserted.instructor_user_id, "roster-user-42");

  const taken = fakeDb({ takenUserIds: ["roster-user-42"] });
  assert.equal((await createInstructorGuarded(taken.db, { ...base, instructor_user_id: "roster-user-42" }, run)).outcome, "duplicate_user_id");
  assert.equal(taken.state.inserted, null);
});

test("editing keeps a User ID once set, and can add one that is missing", async () => {
  const withId = { _id: "i1", college_id: "c1", instructor_user_id: "abc123def456" };

  const same = fakeDb({ existing: withId });
  assert.equal((await updateInstructorGuarded(same.db, "i1", { ...base, instructor_user_id: "abc123def456" }, run)).outcome, "updated");
  assert.equal("instructor_user_id" in same.state.set, false);

  const blank = fakeDb({ existing: withId });
  assert.equal((await updateInstructorGuarded(blank.db, "i1", { ...base, instructor_user_id: undefined }, run)).outcome, "updated");
  assert.equal("instructor_user_id" in blank.state.set, false, "a blank field never clears it");

  const changed = fakeDb({ existing: withId });
  assert.equal((await updateInstructorGuarded(changed.db, "i1", { ...base, instructor_user_id: "other-id-99" }, run)).outcome, "user_id_locked");
  assert.equal(changed.state.set, null);

  const missing = { _id: "i2", college_id: "c1" };
  const added = fakeDb({ existing: missing });
  assert.equal((await updateInstructorGuarded(added.db, "i2", { ...base, instructor_user_id: "new-id-77" }, run)).outcome, "updated");
  assert.equal(added.state.set.instructor_user_id, "new-id-77");

  const clash = fakeDb({ existing: missing, takenUserIds: ["new-id-77"] });
  assert.equal((await updateInstructorGuarded(clash.db, "i2", { ...base, instructor_user_id: "new-id-77" }, run)).outcome, "duplicate_user_id");
});

test("the routes report User ID clashes, and attendance can be read for one instructor", async () => {
  const routes = await readFile(new URL("../src/routes/instructorRoutes.js", import.meta.url), "utf8");
  assert.equal((routes.match(/detail: "Instructor User ID exists"/g) || []).length, 2);
  assert.match(routes, /detail: "An instructor's User ID cannot be changed once it is set"/);
  assert.match(routes, /instructor_user_id: result\.instructor\.instructor_user_id,/);
  const attendance = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  assert.match(attendance, /\.\.\.\(req\.query\.instructor_id \? \{ instructor_id: idMatch\(req\.query\.instructor_id\.trim\(\)\) \} : \{\}\),\s*\.\.\.attendanceScope\(req\.currentUser\),/);
  assert.match(attendance, /instructor_id must be a single instructor id/);
});
