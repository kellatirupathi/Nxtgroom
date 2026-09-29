import assert from "node:assert/strict";
import { test } from "node:test";
import { enqueueMailJob, startMailWorker } from "../src/services/mailWorker.js";
import { enqueueNotification, startNotificationWorker } from "../src/services/notificationWorker.js";
import {
  createIdleBackoff,
  createSweepSchedule,
  createWakeSignal,
} from "../src/services/workerPacing.js";

/**
 * The workers used to poll every two seconds whether or not there was work:
 * about nine database operations a second per server, all day. An idle worker
 * now backs off to 15 s and runs its recovery sweeps once a minute, and a job
 * queued in the same process wakes its worker straight away, so the quiet
 * hours stop costing queries without making anyone wait for an email.
 */

test("an idle worker backs off to the ceiling and returns to zero when work appears", () => {
  const backoff = createIdleBackoff({ minMs: 2000, maxMs: 15000 });
  assert.deepEqual(
    [false, false, false, false, false].map((found) => backoff.afterCycle(found)),
    [2000, 4000, 8000, 15000, 15000]
  );
  assert.equal(backoff.afterCycle(true), 0, "a busy worker drains without waiting");
  assert.equal(backoff.afterCycle(false), 2000, "and starts backing off from the floor again");
});

test("a wake-up resets the back-off", () => {
  const backoff = createIdleBackoff({ minMs: 2000, maxMs: 15000 });
  backoff.afterCycle(false);
  backoff.afterCycle(false);
  backoff.reset();
  assert.equal(backoff.afterCycle(false), 2000);
});

test("a ceiling below the floor never shortens the configured poll", () => {
  const backoff = createIdleBackoff({ minMs: 20000, maxMs: 15000 });
  assert.equal(backoff.afterCycle(false), 20000);
  assert.equal(backoff.afterCycle(false), 20000);
});

test("sweeps run on the first cycle and then once per interval", () => {
  let now = 1_000_000;
  const sweeps = createSweepSchedule(60000, () => now);
  assert.equal(sweeps.due(), true, "first cycle after start");
  now += 2000;
  assert.equal(sweeps.due(), false);
  now += 57999;
  assert.equal(sweeps.due(), false);
  now += 1;
  assert.equal(sweeps.due(), true);
  assert.equal(sweeps.due(), false, "not twice for the same interval");
});

test("a failing wake-up listener cannot break the code that queued the job", () => {
  const signal = createWakeSignal();
  let woken = 0;
  signal.listen(() => {
    throw new Error("listener failed");
  });
  const stop = signal.listen(() => {
    woken += 1;
  });
  assert.doesNotThrow(() => signal.notify());
  assert.equal(woken, 1);
  stop();
  signal.notify();
  assert.equal(woken, 1, "a stopped listener is not called");
});

/** Records every claim attempt; the queue itself is always empty. */
function claimCountingDb(extra = {}) {
  const claims = { mail_jobs: 0, notification_jobs: 0 };
  const collection = (name) => ({
    async findOneAndUpdate() {
      if (name in claims) claims[name] += 1;
      return null;
    },
    async findOne(filter) {
      return extra.findOne ? extra.findOne(name, filter) : null;
    },
    async updateOne() {
      return { matchedCount: 1, modifiedCount: 1 };
    },
  });
  return { claims, db: { collection } };
}

async function waitFor(condition, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("queuing an email wakes the idle mail worker instead of waiting for the next poll", async () => {
  const { claims, db } = claimCountingDb();
  const worker = startMailWorker(db);
  try {
    await waitFor(() => claims.mail_jobs > 0, 1000, "the first poll never ran");
    // Let the first cycle finish and the worker go to sleep for its idle
    // delay (at least one second).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const beforeEnqueue = claims.mail_jobs;
    await enqueueMailJob(db, {
      id: "password-reset:someone@example.com:hash",
      type: "password_reset",
      toEmail: "someone@example.com",
      payload: {},
    });
    await waitFor(
      () => claims.mail_jobs > beforeEnqueue,
      500,
      "the worker slept through a newly queued email"
    );
  } finally {
    await worker.stop();
  }
});

test("queuing a report email wakes the idle notification worker", async () => {
  const { claims, db } = claimCountingDb({
    findOne(name, filter) {
      if (name === "notification_jobs") {
        return { _id: filter._id, attendance_id: "attendance-1", type: "checkin", status: "queued" };
      }
      return null;
    },
  });
  const worker = startNotificationWorker(db);
  try {
    await waitFor(() => claims.notification_jobs > 0, 1000, "the first poll never ran");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const beforeEnqueue = claims.notification_jobs;
    await enqueueNotification(db, {
      attendanceId: "attendance-1",
      type: "checkin",
      toEmail: "instructor@example.com",
      report: {},
    });
    await waitFor(
      () => claims.notification_jobs > beforeEnqueue,
      500,
      "the worker slept through a newly queued report email"
    );
  } finally {
    await worker.stop();
  }
});

test("an email queued while the worker is mid-cycle is claimed without waiting for the back-off", async () => {
  let claims = 0;
  const held = [];
  const db = {
    collection: () => ({
      async findOneAndUpdate() {
        claims += 1;
        // Hold the first cycle's claims open, so the email below is queued
        // after the worker has already looked for jobs in this cycle.
        if (claims <= 2) await new Promise((resolve) => held.push(resolve));
        return null;
      },
      async updateOne() {
        return { matchedCount: 1, modifiedCount: 1 };
      },
    }),
  };
  const worker = startMailWorker(db);
  try {
    await waitFor(() => held.length === 2, 1000, "the first cycle never claimed");
    await enqueueMailJob(db, {
      id: "password-reset:someone@example.com:hash",
      type: "password_reset",
      toEmail: "someone@example.com",
      payload: {},
    });
    for (const release of held) release();
    // Without the mid-cycle wake-up the worker would sleep at least a second.
    await waitFor(
      () => claims > 2,
      500,
      "the worker backed off instead of looking again for the email queued mid-cycle"
    );
  } finally {
    await worker.stop();
  }
});
