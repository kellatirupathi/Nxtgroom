import assert from "node:assert/strict";
import { test } from "node:test";
import { linkInstructorsToInstitutes } from "../src/services/instructorSync.js";

/**
 * college_id is the only scope boundary a BOA has: instructorScope filters on
 * it, so whichever college an instructor lands in decides who can see them,
 * check them in, and read their grooming reports.
 *
 * Linking resolved that from institute_name against a Map keyed on the college
 * name alone. Colleges are unique on (name, location), so two campuses can
 * share a name — and every instructor of that name went to whichever college
 * the cursor happened to return last, silently, into another campus's records.
 */
function fakeDb({ colleges, instructors }) {
  const written = [];
  return {
    written,
    collection(name) {
      if (name === "colleges") {
        return {
          find: (filter) => ({
            project: () => ({ toArray: async () => colleges.filter((row) => matchesActive(row, filter)) }),
            toArray: async () => colleges.filter((row) => matchesActive(row, filter)),
          }),
        };
      }
      if (name === "instructors") {
        return {
          find: () => ({
            project: () => ({ toArray: async () => instructors }),
            toArray: async () => instructors,
          }),
          bulkWrite: async (operations) => {
            written.push(...operations);
            return { modifiedCount: operations.length };
          },
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };
}

/** Mirrors the "not soft deleted" clause the linker now sends. */
function matchesActive(row, filter) {
  if (!filter?.$or) return true;
  return row.deleted_at === null || row.deleted_at === undefined;
}

const assignedCollege = (written, instructorId) => written
  .find((op) => op.updateOne.filter._id === instructorId)
  ?.updateOne.update.$set.college_id;

test("an unambiguous institute name is linked to its college", async () => {
  const db = fakeDb({
    colleges: [{ _id: "c1", name: "Brigade Campus" }, { _id: "c2", name: "Marathahalli Campus" }],
    instructors: [{ _id: "i1", institute_name: " brigade campus " }],
  });

  const result = await linkInstructorsToInstitutes(db);

  assert.equal(result.linked, 1);
  assert.equal(assignedCollege(db.written, "i1"), "c1");
});

test("a name shared by two campuses links nobody", async () => {
  const db = fakeDb({
    colleges: [
      { _id: "c1", name: "NIAT Campus", location: "Hyderabad" },
      { _id: "c2", name: "NIAT Campus", location: "Pune" },
    ],
    instructors: [{ _id: "i1", institute_name: "NIAT Campus" }],
  });

  const result = await linkInstructorsToInstitutes(db);

  assert.equal(result.linked, 0);
  assert.equal(result.ambiguous, 1);
  assert.equal(db.written.length, 0, "a guess here files somebody under the wrong campus's BOA");
});

test("an ambiguous name does not block the instructors around it", async () => {
  const db = fakeDb({
    colleges: [
      { _id: "c1", name: "NIAT Campus", location: "Hyderabad" },
      { _id: "c2", name: "NIAT Campus", location: "Pune" },
      { _id: "c3", name: "Brigade Campus", location: "Bengaluru" },
    ],
    instructors: [
      { _id: "i1", institute_name: "NIAT Campus" },
      { _id: "i2", institute_name: "Brigade Campus" },
      { _id: "i3", institute_name: "Nowhere Campus" },
    ],
  });

  const result = await linkInstructorsToInstitutes(db);

  assert.equal(result.linked, 1);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.unmatched, 1);
  assert.equal(assignedCollege(db.written, "i2"), "c3");
});

test("a soft-deleted college is not somewhere anyone can be placed", async () => {
  const db = fakeDb({
    colleges: [{ _id: "c1", name: "Closed Campus", deleted_at: new Date() }],
    instructors: [{ _id: "i1", institute_name: "Closed Campus" }],
  });

  const result = await linkInstructorsToInstitutes(db);

  assert.equal(result.linked, 0);
  assert.equal(result.unmatched, 1);
});
