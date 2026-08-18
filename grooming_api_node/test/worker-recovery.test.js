import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  enqueueEvaluation,
  recoverClaimedEvaluation,
  reconcileEvaluationOutbox,
  reconcileExpiredEvaluationJobs,
  reconcileFailedEvaluationOutcomes,
  reconcileOverdueEvaluationJobs,
} from "../src/services/evaluationWorker.js";
import {
  enqueueNotification,
  prepareCheckoutReport,
  reconcileCheckoutOutbox,
  reconcileExpiredNotificationJobs,
  reconcileOverdueNotificationJobs,
} from "../src/services/notificationWorker.js";
import {
  checkInConcurrencyGate,
  serializeAttendance,
} from "../src/routes/attendanceRoutes.js";

function fakeDb(collections) {
  // enqueueNotification consults workspace notification settings before
  // queueing mail. Default the stub to "not configured" so these tests keep
  // exercising the permissive defaults unless a case overrides it.
  const withDefaults = {
    app_settings: { findOne: async () => null },
    ...collections,
  };
  return {
    collection(name) {
      assert.ok(withDefaults[name], `Unexpected collection: ${name}`);
      return withDefaults[name];
    },
  };
}

test("evaluation outbox reconciliation creates one deterministic job and clears the photo source", async () => {
  const jobWrites = [];
  const attendanceWrites = [];
  // Relative to now: a hardcoded deadline silently expires and makes
  // reconciliation take the EVALUATION_DEADLINE_EXCEEDED branch instead.
  const checkInTime = new Date(Date.now() - 60 * 60 * 1000);
  const deadlineAt = new Date(Date.now() + 23 * 60 * 60 * 1000);
  const attendance = {
    _id: "attendance-1",
    check_in_time: checkInTime,
    _private_evaluation_outbox: {
      instructor: { name: "Instructor", email: "instructor@example.com", gender: "MALE" },
      // Photos live in R2; the outbox carries only the object key.
      photo_key: "attendance/2026/08/17/instructor-1-checkin-abc123.jpg",
      mime_type: "image/jpeg",
      check_in_time: checkInTime,
      deadline_at: deadlineAt,
    },
  };
  const db = fakeDb({
    attendance: {
      findOne: async () => attendance,
      updateOne: async (...args) => {
        attendanceWrites.push(args);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
    evaluation_jobs: {
      updateOne: async (...args) => {
        jobWrites.push(args);
        return { upsertedCount: jobWrites.length === 1 ? 1 : 0 };
      },
      findOne: async () => ({ _id: "attendance-1:evaluation", status: "queued" }),
    },
  });

  await reconcileEvaluationOutbox(db);
  await enqueueEvaluation(db, {
    attendanceId: attendance._id,
    instructor: attendance._private_evaluation_outbox.instructor,
    photoKey: attendance._private_evaluation_outbox.photo_key,
    mimeType: "image/jpeg",
    checkInTime: attendance.check_in_time,
  });

  assert.equal(jobWrites.length, 2);
  assert.deepEqual(jobWrites.map(([filter]) => filter), [
    { _id: "attendance-1:evaluation" },
    { _id: "attendance-1:evaluation" },
  ]);
  const queued = jobWrites[0][1].$setOnInsert;
  assert.equal(queued.photo_key, "attendance/2026/08/17/instructor-1-checkin-abc123.jpg");
  assert.equal(
    Object.prototype.hasOwnProperty.call(queued, "image"),
    false,
    "image bytes must never be written to MongoDB",
  );
  assert.equal(attendanceWrites[0][1].$unset._private_evaluation_outbox, "");
});

test("an expired final evaluation attempt is terminalized and sensitive payloads are removed", async () => {
  const jobTransitions = [];
  const jobUpdates = [];
  const attendanceUpdates = [];
  const job = {
    _id: "attendance-2:evaluation",
    attendance_id: "attendance-2",
    attempts: 3,
    status: "recovering",
    instructor: { name: "Failure", email: "failure@example.com" },
    check_in_time: new Date("2026-08-14T03:30:00.000Z"),
  };
  const db = fakeDb({
    evaluation_jobs: {
      findOneAndUpdate: async (...args) => {
        jobTransitions.push(args);
        if (jobTransitions.length === 1) return job;
        return {
          ...job,
          status: "failed",
          error_code: args[1].$set.error_code,
          failure_notification: args[1].$set.failure_notification,
        };
      },
      updateOne: async (...args) => {
        jobUpdates.push(args);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
    evaluations: { findOne: async () => null },
    attendance: {
      updateOne: async (...args) => {
        attendanceUpdates.push(args);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
    notification_jobs: {
      updateOne: async () => ({ upsertedCount: 1 }),
      findOne: async () => ({
        _id: "attendance-2:checkin",
        attendance_id: "attendance-2",
        type: "checkin",
        status: "queued",
      }),
    },
  });

  assert.equal(await reconcileExpiredEvaluationJobs(db, new Date()), true);
  assert.deepEqual(jobTransitions[0][0].status.$in, ["processing", "recovering"]);
  assert.equal(jobTransitions[1][1].$set.status, "failed");
  assert.equal(jobTransitions[1][1].$unset.image, "");
  assert.equal(jobTransitions[1][1].$unset.instructor, "");
  assert.equal(jobTransitions[1][1].$set.expires_at, undefined);
  assert.ok(jobUpdates[0][1].$set.expires_at instanceof Date);
  assert.equal(jobUpdates[0][1].$unset.failure_notification, "");
  assert.equal(attendanceUpdates[0][1].$set.analysis_error_code, "EVALUATION_LEASE_EXPIRED");
  assert.equal(attendanceUpdates[0][1].$unset._private_evaluation_outbox, "");
  assert.equal(attendanceUpdates[0][1].$set.checkin_email_status, "outbox_pending");
  assert.equal(attendanceUpdates[1][1].$set.checkin_email_status, "queued");
});

test("a final-attempt crash after evaluation persistence completes remaining effects without re-analysis", async () => {
  const attendanceUpdates = [];
  const deletedJobs = [];
  const job = {
    _id: "attendance-3:evaluation",
    attendance_id: "attendance-3",
    attempts: 3,
    status: "recovering",
    instructor: { name: "Recovered", email: "recovered@example.com" },
    check_in_time: new Date("2026-08-14T03:30:00.000Z"),
  };
  const notificationJob = {
    _id: "attendance-3:checkin",
    attendance_id: "attendance-3",
    type: "checkin",
    status: "queued",
  };
  const db = fakeDb({
    evaluation_jobs: {
      findOneAndUpdate: async () => job,
      deleteOne: async (...args) => {
        deletedJobs.push(args);
        return { deletedCount: 1 };
      },
      updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }),
    },
    evaluations: {
      findOne: async () => ({
        attendance_id: "attendance-3",
        overall_status: "COMPLIANT",
        ai_summary: "All checks passed.",
        image_quality: "ADEQUATE",
        processed_at: new Date("2026-08-14T03:31:00.000Z"),
      }),
    },
    notification_jobs: {
      updateOne: async () => ({ upsertedCount: 1 }),
      findOne: async () => notificationJob,
    },
    attendance: {
      updateOne: async (...args) => {
        attendanceUpdates.push(args);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
  });

  assert.equal(await reconcileExpiredEvaluationJobs(db, new Date()), true);
  assert.equal(attendanceUpdates[0][1].$set.status, "compliant");
  assert.equal(attendanceUpdates[0][1].$set.evaluation_queue_status, "completed");
  assert.equal(deletedJobs[0][0].status, "recovering");
});

test("a normal retry reuses a stored evaluation rather than paying for it twice", async () => {
  const attendanceUpdates = [];
  const deletedJobs = [];
  const job = {
    _id: "attendance-normal:evaluation",
    attendance_id: "attendance-normal",
    attempts: 2,
    status: "processing",
    worker_id: "claimed-by-module-worker",
    lease_until: new Date(Date.now() + 60000),
    instructor: { name: "Review", email: "review@example.com" },
    check_in_time: new Date("2026-08-14T03:30:00.000Z"),
  };
  const db = fakeDb({
    evaluations: {
      findOne: async () => ({
        attendance_id: "attendance-normal",
        overall_status: "COMPLIANT",
        ai_summary: "Critical item was not visible.",
        image_quality: "RETAKE_RECOMMENDED",
        processed_at: new Date("2026-08-14T03:31:00.000Z"),
      }),
    },
    evaluation_jobs: {
      updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }),
      deleteOne: async (...args) => {
        deletedJobs.push(args);
        return { deletedCount: 1 };
      },
    },
    notification_jobs: {
      updateOne: async () => ({ upsertedCount: 1 }),
      findOne: async () => ({
        _id: "attendance-normal:checkin",
        attendance_id: "attendance-normal",
        type: "checkin",
        status: "queued",
      }),
    },
    attendance: {
      updateOne: async (...args) => {
        attendanceUpdates.push(args);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
  });

  assert.equal(await recoverClaimedEvaluation(db, job), true);
  assert.equal(attendanceUpdates[0][1].$set.status, "compliant");
  assert.equal(attendanceUpdates[0][1].$set.compliance_status, "COMPLIANT");
  // The photo quality is still recorded, so the instructor is still told to
  // retake it even though nothing failed.
  assert.equal(attendanceUpdates[0][1].$set.image_quality, "RETAKE_RECOMMENDED");
  assert.equal(deletedJobs.length, 1);
});

test("a failed evaluation outcome is reconciled after a crash before attendance sync", async () => {
  const attendanceUpdates = [];
  const failureSyncUpdates = [];
  const failureNotification = {
    to_email: "failed@example.com",
    report: {
      instructorName: "Failed",
      overallStatus: "error",
      aiSummary: "AI analysis could not be completed.",
      checkInTime: new Date("2026-08-14T03:30:00.000Z"),
    },
    deadline_at: new Date(Date.now() + 60000),
  };
  const db = fakeDb({
    evaluation_jobs: {
      findOne: async () => ({
        _id: "attendance-failed:evaluation",
        attendance_id: "attendance-failed",
        status: "failed",
        error_code: "EVALUATION_DEADLINE_EXCEEDED",
        failure_notification: failureNotification,
      }),
      updateOne: async (...args) => {
        failureSyncUpdates.push(args);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
    notification_jobs: {
      updateOne: async () => ({ upsertedCount: 1 }),
      findOne: async () => ({
        _id: "attendance-failed:checkin",
        attendance_id: "attendance-failed",
        type: "checkin",
        status: "queued",
      }),
    },
    attendance: {
      updateOne: async (...args) => {
        attendanceUpdates.push(args);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
  });

  assert.equal(await reconcileFailedEvaluationOutcomes(db), true);
  assert.equal(attendanceUpdates[0][1].$set.status, "error");
  assert.equal(attendanceUpdates[0][1].$set.checkin_email_status, "outbox_pending");
  assert.deepEqual(attendanceUpdates[0][1].$set._private_checkin_outbox, failureNotification);
  assert.ok(failureSyncUpdates[0][1].$set.failure_synced_at instanceof Date);
  assert.ok(failureSyncUpdates[0][1].$set.expires_at instanceof Date);
  assert.equal(failureSyncUpdates[0][1].$unset.failure_notification, "");
  assert.equal(attendanceUpdates[1][1].$set.checkin_email_status, "queued");
});

test("overdue evaluation jobs are claimed by the privacy sweeper", async () => {
  let query;
  const now = new Date("2026-08-15T12:00:00.000Z");
  const db = fakeDb({
    evaluation_jobs: {
      findOneAndUpdate: async (value) => {
        query = value;
        return null;
      },
    },
  });
  assert.equal(await reconcileOverdueEvaluationJobs(db, now), false);
  assert.equal(query.$and[0].$or[0].deadline_at.$lte, now);
  assert.ok(query.$and[0].$or[1].created_at.$lte < now);
});

test("checkout outbox reconciliation creates a deterministic notification and clears private mail data", async () => {
  const notificationWrites = [];
  const attendanceWrites = [];
  const attendance = {
    _id: "attendance-4",
    _private_checkout_outbox: {
      to_email: "checkout@example.com",
      report: { instructorName: "Checkout" },
      deadline_at: new Date(Date.now() + 60000),
    },
  };
  const db = fakeDb({
    attendance: {
      findOne: async () => attendance,
      updateOne: async (...args) => {
        attendanceWrites.push(args);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
    notification_jobs: {
      updateOne: async (...args) => {
        notificationWrites.push(args);
        return { upsertedCount: 1 };
      },
      findOne: async () => ({
        _id: "attendance-4:checkout",
        attendance_id: "attendance-4",
        type: "checkout",
        status: "queued",
      }),
    },
  });

  assert.equal(await reconcileCheckoutOutbox(db), true);
  assert.deepEqual(notificationWrites[0][0], { _id: "attendance-4:checkout" });
  assert.equal(attendanceWrites[0][1].$unset._private_checkout_outbox, "");
});

test("checkout waits for analysis and the check-in email, then uses current attendance values", async () => {
  let deferUpdate;
  const pendingDb = fakeDb({
    attendance: {
      findOne: async () => ({ status: "pending", checkin_email_status: "waiting_for_analysis" }),
    },
    notification_jobs: {
      updateOne: async (...args) => {
        deferUpdate = args;
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
  });
  const job = {
    _id: "attendance-5:checkout",
    attendance_id: "attendance-5",
    type: "checkout",
    report: { checkOutTime: "original" },
  };
  assert.equal(await prepareCheckoutReport(pendingDb, job), null);
  assert.equal(deferUpdate[1].$inc.attempts, -1);
  assert.equal(deferUpdate[1].$set.status, "queued");

  const exactCheckout = new Date("2026-08-14T11:30:00.000Z");
  const readyDb = fakeDb({
    attendance: {
      findOne: async () => ({
        instructor_name: "Current Name",
        status: "non_compliant",
        remarks: "ID card missing.",
        check_in_time: new Date("2026-08-14T03:30:00.000Z"),
        check_out_time: exactCheckout,
        checkin_email_status: "sent",
        image_quality: "RETAKE_RECOMMENDED",
      }),
    },
  });
  const prepared = await prepareCheckoutReport(readyDb, job);
  assert.equal(prepared.report.status, "non_compliant");
  assert.equal(prepared.report.remarks, "ID card missing.");
  assert.equal(prepared.report.checkOutTime, exactCheckout);
  assert.equal(prepared.report.imageQuality, "RETAKE_RECOMMENDED");
});

test("expired final notification attempts become delivery_unknown and clear PII", async () => {
  const notificationWrites = [];
  const attendanceWrites = [];
  const terminalJob = {
    _id: "attendance-6:checkout",
    attendance_id: "attendance-6",
    type: "checkout",
    status: "delivery_unknown",
  };
  const db = fakeDb({
    notification_jobs: {
      findOneAndUpdate: async (...args) => {
        notificationWrites.push(args);
        return terminalJob;
      },
      updateOne: async (...args) => {
        notificationWrites.push(args);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
    attendance: {
      updateOne: async (...args) => {
        attendanceWrites.push(args);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
  });

  assert.equal(await reconcileExpiredNotificationJobs(db, new Date()), true);
  assert.equal(notificationWrites[0][1].$set.status, "delivery_unknown");
  assert.equal(notificationWrites[0][1].$unset.to_email, "");
  assert.equal(notificationWrites[0][1].$unset.report, "");
  assert.equal(notificationWrites[0][1].$set.expires_at, undefined);
  assert.ok(notificationWrites[1][1].$set.expires_at instanceof Date);
  assert.equal(attendanceWrites[0][1].$set.checkout_email_status, "delivery_unknown");
});

test("overdue queued notifications fail terminally and clear recipient/report data", async () => {
  let terminalUpdate;
  const terminalJob = {
    _id: "attendance-7:checkin",
    attendance_id: "attendance-7",
    type: "checkin",
    status: "failed",
  };
  const db = fakeDb({
    notification_jobs: {
      findOneAndUpdate: async (_filter, update) => {
        terminalUpdate = update;
        return terminalJob;
      },
      updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }),
    },
    attendance: {
      updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }),
    },
  });

  assert.equal(await reconcileOverdueNotificationJobs(db, new Date()), true);
  assert.equal(terminalUpdate.$set.last_error, "NOTIFICATION_DEADLINE_EXCEEDED");
  assert.equal(terminalUpdate.$unset.to_email, "");
  assert.equal(terminalUpdate.$unset.report, "");
});

test("attendance serialization never exposes embedded image or email outboxes", () => {
  const serialized = serializeAttendance({
    _id: "attendance-8",
    status: "pending",
    _private_evaluation_outbox: { image: Buffer.from("secret-photo") },
    _private_checkout_outbox: { to_email: "private@example.com" },
  });
  assert.deepEqual(serialized, { _id: "attendance-8", status: "pending" });
});

test("check-in concurrency gate admits two decodes and releases each slot exactly once", () => {
  function response() {
    const value = new EventEmitter();
    value.set = () => value;
    value.status = (status) => {
      value.statusCode = status;
      return value;
    };
    value.json = (body) => {
      value.body = body;
      return value;
    };
    return value;
  }

  const first = response();
  const second = response();
  const rejected = response();
  const replacement = response();
  let admitted = 0;
  checkInConcurrencyGate({}, first, () => { admitted += 1; });
  checkInConcurrencyGate({}, second, () => { admitted += 1; });
  checkInConcurrencyGate({}, rejected, () => { admitted += 1; });
  assert.equal(admitted, 2);
  assert.equal(rejected.statusCode, 503);

  first.emit("finish");
  first.emit("close");
  checkInConcurrencyGate({}, replacement, () => { admitted += 1; });
  assert.equal(admitted, 3);
  second.emit("close");
  replacement.emit("finish");
});

test("notification enqueue is idempotent for the same attendance and type", async () => {
  const filters = [];
  const db = fakeDb({
    notification_jobs: {
      updateOne: async (filter) => {
        filters.push(filter);
        return { upsertedCount: filters.length === 1 ? 1 : 0 };
      },
      findOne: async () => ({
        _id: "attendance-9:checkin",
        attendance_id: "attendance-9",
        type: "checkin",
        status: "queued",
      }),
    },
    attendance: {
      updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }),
    },
  });
  const input = {
    attendanceId: "attendance-9",
    type: "checkin",
    toEmail: "instructor@example.com",
    report: { instructorName: "Instructor" },
  };
  await enqueueNotification(db, input);
  await enqueueNotification(db, input);
  assert.deepEqual(filters, [
    { _id: "attendance-9:checkin" },
    { _id: "attendance-9:checkin" },
  ]);
});
