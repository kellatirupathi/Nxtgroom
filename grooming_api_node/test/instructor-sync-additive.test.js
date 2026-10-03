import assert from "node:assert/strict";
import { test } from "node:test";
import { saveInstructorRoster } from "../src/services/instructorSync.js";

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
    email: "sumit@nxtwave.co.in",
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

  for (const field of ["college_id", "gender", "deleted_at", "created_at"]) {
    assert.ok(field in updateOne.update.$setOnInsert, `${field} belongs in $setOnInsert`);
    assert.equal(field in updateOne.update.$set, false, `${field} must not be overwritten on re-sync`);
  }
});

test("a missing email never overwrites one entered by hand", async () => {
  const db = recordingDb();
  await saveInstructorRoster(db, [{ ...roster[0], email: null }]);
  const [{ updateOne }] = db.operations();

  assert.equal(
    "email" in updateOne.update.$set,
    false,
    "a null email must be dropped, not written over an existing address",
  );
  assert.equal(updateOne.update.$set.name, "Sumit Kumar", "the rest of the row still syncs");
});

test("an email the warehouse does supply is written", async () => {
  const db = recordingDb();
  await saveInstructorRoster(db, roster);
  const [{ updateOne }] = db.operations();
  assert.equal(updateOne.update.$set.email, "sumit@nxtwave.co.in");
});

test("an empty roster performs no writes at all", async () => {
  const db = recordingDb();
  const result = await saveInstructorRoster(db, []);
  assert.deepEqual(db.operations(), []);
  assert.deepEqual(result, { upserted: 0, modified: 0 });
});
