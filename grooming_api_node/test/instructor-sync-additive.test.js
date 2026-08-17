import assert from "node:assert/strict";
import { test } from "node:test";
import { saveInstructorRoster } from "../src/services/instructorSync.js";

/**
 * The sync must never remove anything. An instructor who has left the BigQuery
 * roster still has attendance history in FacultyTrack, and deleting the row
 * would orphan those records. A sync adds what is new, updates what changed,
 * and leaves everything else alone.
 *
 * These tests inspect the operations handed to bulkWrite rather than a real
 * database, so a destructive operation fails here before it can ever run.
 */
function recordingDb() {
  const batches = [];
  return {
    operations: () => batches.flat(),
    collection(name) {
      assert.equal(name, "instructors");
      return {
        async bulkWrite(operations) {
          batches.push(operations);
          return { upsertedCount: operations.length, modifiedCount: 0 };
        },
      };
    },
  };
}

const roster = [
  {
    instructor_user_id: "U-1",
    name: "Sumit Kumar",
    instructor_role: "CENTRAL_INSTRUCTOR",
    institute_name: "Vivekananda global University",
    instructor_category: "TECH",
    employee_id: null,
    phone_no: null,
    email: null,
    manager_email: "manager@nxtwave.co.in",
  },
];

test("a sync issues no delete, drop, or replace operation", async () => {
  const db = recordingDb();
  await saveInstructorRoster(db, roster);

  for (const operation of db.operations()) {
    const kinds = Object.keys(operation);
    assert.deepEqual(kinds, ["updateOne"], `unexpected operation: ${kinds.join(",")}`);
    for (const forbidden of ["deleteOne", "deleteMany", "replaceOne"]) {
      assert.equal(forbidden in operation, false, `${forbidden} must never be generated`);
    }
  }
});

test("instructors missing from BigQuery are untouched, not removed", async () => {
  const db = recordingDb();
  await saveInstructorRoster(db, roster);

  // Every write is keyed to an id present in this run, so a person who has
  // left the roster is never matched by any filter and simply survives.
  const targeted = db.operations().map((op) => op.updateOne.filter.instructor_user_id);
  assert.deepEqual(targeted, ["U-1"]);
  assert.equal(
    targeted.includes("U-GONE"),
    false,
    "a departed instructor is not addressed at all, so nothing can remove them",
  );
});

test("changed values are written, and new people are inserted", async () => {
  const db = recordingDb();
  await saveInstructorRoster(db, roster);
  const [{ updateOne }] = db.operations();

  assert.equal(updateOne.upsert, true, "a new instructor is inserted");
  assert.equal(updateOne.update.$set.instructor_role, "CENTRAL_INSTRUCTOR");
  assert.equal(updateOne.update.$set.institute_name, "Vivekananda global University");
  assert.equal(updateOne.update.$set.instructor_category, "TECH");
});

test("fields FacultyTrack owns are set only when the record is created", async () => {
  const db = recordingDb();
  await saveInstructorRoster(db, roster);
  const [{ updateOne }] = db.operations();

  // A re-sync must not reset a college assignment or resurrect a soft-deleted
  // instructor, so these live in $setOnInsert rather than $set.
  for (const field of ["college_id", "gender", "deleted_at", "created_at"]) {
    assert.ok(field in updateOne.update.$setOnInsert, `${field} belongs in $setOnInsert`);
    assert.equal(field in updateOne.update.$set, false, `${field} must not be overwritten on re-sync`);
  }
});

test("blank warehouse columns never overwrite a value entered by hand", async () => {
  const db = recordingDb();
  await saveInstructorRoster(db, roster);
  const [{ updateOne }] = db.operations();
  const written = updateOne.update.$set;

  // This table carries no email, phone, or employee id at all. Writing those
  // nulls would erase contact details an administrator added, and check-in
  // needs the email address to send the grooming report.
  for (const field of ["email", "phone_no", "employee_id"]) {
    assert.equal(field in written, false, `null ${field} must be dropped, not written`);
  }
  // A value the warehouse does supply is still written.
  assert.equal(written.manager_email, "manager@nxtwave.co.in");
});

test("an empty roster performs no writes at all", async () => {
  const db = recordingDb();
  const result = await saveInstructorRoster(db, []);
  // A failed or empty fetch must not touch the collection.
  assert.deepEqual(db.operations(), []);
  assert.deepEqual(result, { upserted: 0, modified: 0 });
});
