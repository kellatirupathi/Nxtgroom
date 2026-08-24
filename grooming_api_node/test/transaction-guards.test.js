import assert from "node:assert/strict";
import { test } from "node:test";
import { attendanceOnLocalDay, commitGuardedCheckIn } from "../src/routes/attendanceRoutes.js";
import {
  createInstructorGuarded,
  deleteInstructorGuarded,
  updateInstructorGuarded,
} from "../src/routes/instructorRoutes.js";

function transactionRunner(session) {
  return async (work) => work(session);
}

test("guarded check-in locks the instructor and inserts attendance in one transaction", async () => {
  const session = { id: "checkin-session" };
  const instructor = {
    _id: "instructor-1",
    name: "Current Name",
    role: "Trainee",
    gender: "MALE",
    college_id: "college-1",
    email: "current@example.com",
    deleted_at: null,
  };
  let guardWrites = 0;
  let insertedAttendance = null;
  const db = {
    collection(name) {
      if (name === "instructors") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          return instructor;
        },
        updateOne: async (_query, update, options) => {
          assert.equal(options.session, session);
          assert.equal(update.$inc._private_attendance_guard_version, 1);
          guardWrites += 1;
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
      if (name === "attendance") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          return null;
        },
        insertOne: async (document, options) => {
          assert.equal(options.session, session);
          insertedAttendance = document;
          return { insertedId: document._id };
        },
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };

  const result = await commitGuardedCheckIn(
    db,
    {
      currentUser: { role: "SUPER_ADMIN", referenceId: null },
      instructorId: instructor._id,
      coordinates: "17.45,78.38",
      normalizedImage: { buffer: Buffer.from("normalized"), mimeType: "image/jpeg" },
      now: new Date("2026-08-24T05:08:00.000Z"),
    },
    transactionRunner(session)
  );

  assert.equal(result.outcome, "created");
  assert.equal(guardWrites, 1);
  assert.equal(insertedAttendance.instructor_name, "Current Name");
  assert.equal(insertedAttendance.attendance_day, "2026-08-24");
  assert.equal(insertedAttendance._private_evaluation_outbox.instructor.email, "current@example.com");
});

test("daily attendance lookup ignores an unfinished record from a previous local day", () => {
  const filter = attendanceOnLocalDay(
    "instructor-1",
    new Date("2026-08-24T05:08:00.000Z")
  );
  assert.equal(filter.$or[0].attendance_day, "2026-08-24");
  assert.equal(filter.$or[1].attendance_day.$exists, false);
  assert.equal(filter.$or[1].check_in_time.$gte.toISOString(), "2026-08-23T18:30:00.000Z");
  assert.equal(filter.$or[1].check_in_time.$lt.toISOString(), "2026-08-24T18:30:00.000Z");
});

test("guarded instructor update shares the transaction boundary with check-in", async () => {
  const session = { id: "update-session" };
  const existing = { _id: "instructor-2", employee_id: "EMP-2", deleted_at: null };
  let instructorReads = 0;
  let updates = 0;
  const db = {
    collection(name) {
      if (name === "instructors") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          instructorReads += 1;
          return instructorReads === 1 ? existing : null;
        },
        updateOne: async (_query, update, options) => {
          assert.equal(options.session, session);
          assert.equal(update.$set.name, "Updated Name");
          updates += 1;
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
      if (name === "attendance") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          return null;
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

  const result = await updateInstructorGuarded(
    db,
    existing._id,
    {
      employee_id: "EMP-2",
      name: "Updated Name",
      role: "Trainee",
      gender: "MALE",
      college_id: "college-2",
      email: "updated@example.com",
    },
    transactionRunner(session)
  );

  assert.equal(result.outcome, "updated");
  assert.equal(updates, 1);
});

test("instructor creation guards its active college assignment transaction", async () => {
  const session = { id: "instructor-create-session" };
  let inserted;
  const db = {
    collection(name) {
      if (name === "colleges") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          return { _id: "college-create" };
        },
        updateOne: async (_query, update, options) => {
          assert.equal(options.session, session);
          assert.equal(update.$inc._private_assignment_guard_version, 1);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
      if (name === "instructors") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          return null;
        },
        insertOne: async (document, options) => {
          assert.equal(options.session, session);
          inserted = document;
          return { insertedId: document._id };
        },
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };

  const result = await createInstructorGuarded(
    db,
    {
      employee_id: "EMP-CREATE",
      name: "Created Instructor",
      role: "Trainee",
      gender: "MALE",
      college_id: "college-create",
      email: "created@example.com",
    },
    transactionRunner(session)
  );
  assert.equal(result.outcome, "created");
  assert.equal(inserted.college_id, "college-create");
  assert.equal(inserted.deleted_at, null);
});

test("guarded instructor deletion refuses an open attendance before mutating profile", async () => {
  const session = { id: "delete-session" };
  let updates = 0;
  const db = {
    collection(name) {
      if (name === "instructors") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          return { _id: "instructor-3", deleted_at: null };
        },
        updateOne: async () => {
          updates += 1;
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
      if (name === "attendance") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          return { _id: "active-attendance", check_out_time: null };
        },
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };

  const result = await deleteInstructorGuarded(
    db,
    "instructor-3",
    transactionRunner(session)
  );
  assert.equal(result.outcome, "active_attendance");
  assert.equal(updates, 0);
});

test("guarded instructor deletion writes the instructor in the shared transaction", async () => {
  const session = { id: "successful-delete-session" };
  let updates = 0;
  const db = {
    collection(name) {
      if (name === "instructors") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          return { _id: "instructor-4", deleted_at: null };
        },
        updateOne: async (_query, update, options) => {
          assert.equal(options.session, session);
          assert.ok(update.$set.deleted_at instanceof Date);
          updates += 1;
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
      if (name === "attendance") return {
        findOne: async (_query, options) => {
          assert.equal(options.session, session);
          return null;
        },
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };

  const result = await deleteInstructorGuarded(
    db,
    "instructor-4",
    transactionRunner(session)
  );
  assert.equal(result.outcome, "deleted");
  assert.equal(updates, 1);
});

test("an ordinary profile edit is not blocked by an open check-in", async () => {
  // Only a college reassignment conflicts with an open session. Refusing name,
  // email, gender and role edits too meant one forgotten check-out made the
  // whole profile permanently uneditable.
  let attendanceQueried = false;
  const db = {
    collection(name) {
      if (name === "instructors") return {
        // The duplicate-employee-id lookup excludes the row being edited, so
        // it must not match the instructor itself.
        findOne: async (filter) => (filter?._id?.$ne
          ? null
          : { _id: "i1", college_id: "c1", employee_id: "E1" }),
        updateOne: async () => ({ matchedCount: 1 }),
      };
      if (name === "attendance") return {
        findOne: async () => { attendanceQueried = true; return { _id: "open" }; },
      };
      if (name === "colleges") return {
        findOne: async () => ({ _id: "c1" }),
        updateOne: async () => ({ matchedCount: 1 }),
      };
      throw new Error(`unexpected ${name}`);
    },
  };

  const sameCollege = await updateInstructorGuarded(
    db,
    "i1",
    { name: "New Name", college_id: "c1", employee_id: "E1" },
    async (run) => run({})
  );
  assert.equal(sameCollege.outcome, "updated");
  assert.equal(attendanceQueried, false, "an open check-in is irrelevant to a name change");

  // Moving them to another institute still refuses: the attendance record
  // snapshots the college, and the session is still running.
  const moved = await updateInstructorGuarded(
    db,
    "i1",
    { name: "New Name", college_id: "c2", employee_id: "E1" },
    async (run) => run({})
  );
  assert.equal(moved.outcome, "active_attendance");
  assert.equal(attendanceQueried, true);
});
