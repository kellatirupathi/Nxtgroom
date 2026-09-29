import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverAttendanceReminders } from "../src/routes/reportRoutes.js";
import { recordRunTerminal } from "../src/services/mailWorker.js";

/**
 * A delivery run counts the emails of one cron job (weekly reports, evening
 * reminders) and is marked completed when every one has been delivered or
 * has failed. The mail worker now starts sending as soon as a job is queued,
 * so deliveries routinely land while the cron job is still queuing. These
 * reproduce that: every email is "delivered" the moment it is queued.
 */

function matches(document, filter) {
  for (const [field, condition] of Object.entries(filter)) {
    if (field === "$expr") {
      const [left, right] = condition.$gte.map((path) => document[path.slice(1)]);
      if (!(left >= right)) return false;
    } else if (condition && typeof condition === "object" && "$gte" in condition) {
      if (!(document[field] >= condition.$gte)) return false;
    } else if (document[field] !== condition) {
      return false;
    }
  }
  return true;
}

function reminderDb({ openCheckIns }) {
  const runs = new Map();
  const mailJobs = [];
  const db = {
    runs,
    mailJobs,
    collection(name) {
      if (name === "attendance") {
        return { find: () => ({ toArray: async () => openCheckIns }) };
      }
      if (name === "instructors") {
        return { findOne: async () => ({ email: "instructor@example.com", name: "Instructor" }) };
      }
      if (name === "mail_jobs") {
        return {
          async updateOne({ _id }, update) {
            mailJobs.push(_id);
            // Delivered at once, exactly as the woken mail worker may.
            await recordRunTerminal(db, update.$setOnInsert.run_id, "sent", new Date());
            return { matchedCount: 0, upsertedCount: 1 };
          },
        };
      }
      assert.equal(name, "report_delivery_runs");
      return {
        async updateOne(filter, update, { upsert = false } = {}) {
          const existing = runs.get(filter._id);
          if (existing && !matches(existing, filter)) return { matchedCount: 0 };
          if (!existing && !upsert) return { matchedCount: 0 };
          const next = existing ? { ...existing } : { _id: filter._id, ...update.$setOnInsert };
          Object.assign(next, update.$set);
          runs.set(filter._id, next);
          return { matchedCount: existing ? 1 : 0 };
        },
        async findOneAndUpdate(filter, update) {
          const existing = runs.get(filter._id);
          // No upsert, as in the worker: a count for a missing run is lost.
          if (!existing) return null;
          for (const [field, amount] of Object.entries(update.$inc)) {
            existing[field] = (existing[field] || 0) + amount;
          }
          Object.assign(existing, update.$set);
          return { ...existing };
        },
      };
    },
  };
  return db;
}

function openCheckIn(id) {
  return { _id: id, instructor_id: `instructor-${id}`, check_in_time: new Date(), check_out_time: null };
}

test("a reminder delivered while the run is still queuing is counted, and the run completes", async () => {
  const db = reminderDb({ openCheckIns: [openCheckIn("a"), openCheckIn("b")] });
  const result = await deliverAttendanceReminders(db);
  assert.equal(result.queued, 2);
  assert.equal(db.mailJobs.length, 2);

  const [run] = [...db.runs.values()];
  assert.equal(run.sent, 2, "no delivery count was lost");
  assert.equal(run.terminal, 2);
  assert.equal(run.queued, 2);
  assert.equal(run.status, "completed");
  assert.ok(run.finished_at instanceof Date);
});

test("a run with nothing to send completes at once", async () => {
  const db = reminderDb({ openCheckIns: [] });
  await deliverAttendanceReminders(db);
  const [run] = [...db.runs.values()];
  assert.deepEqual([run.queued, run.terminal, run.status], [0, 0, "completed"]);
});
