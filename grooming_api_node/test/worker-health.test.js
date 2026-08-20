import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWorkerMonitor,
  getQueueAgeMetrics,
  getWorkerHeartbeatSnapshot,
  getWorkerReadiness,
  resetWorkerHealthForTests,
} from "../src/services/workerHealth.js";

function queueDb(documents = {}) {
  return {
    collection(name) {
      return {
        async findOne(filter) {
          if (name !== "attendance") return documents[name] || null;
          const field = Object.keys(filter)[0];
          return documents[field] || null;
        },
      };
    },
  };
}

test("worker heartbeat reports missing, healthy, stale, and stopped states", () => {
  resetWorkerHealthForTests();
  let current = new Date("2026-08-14T12:00:00.000Z");
  const now = () => new Date(current);
  const evaluation = createWorkerMonitor("evaluation", {
    heartbeatIntervalMs: 60 * 60 * 1000,
    now,
  });
  const notification = createWorkerMonitor("notification", {
    heartbeatIntervalMs: 60 * 60 * 1000,
    now,
  });
  evaluation.cycleStarted();
  evaluation.recordJobError("GEMINI_TIMEOUT");
  evaluation.cycleCompleted();

  let snapshot = getWorkerHeartbeatSnapshot({ now: current, staleAfterMs: 60000 });
  assert.equal(snapshot.every((worker) => worker.state === "ok"), true);
  assert.equal(snapshot[0].last_job_error_code, "GEMINI_TIMEOUT");

  current = new Date(current.getTime() + 61000);
  snapshot = getWorkerHeartbeatSnapshot({ now: current, staleAfterMs: 60000 });
  assert.equal(snapshot.every((worker) => worker.state === "stale"), true);
  evaluation.heartbeat();
  assert.equal(
    getWorkerHeartbeatSnapshot({ now: current, staleAfterMs: 60000 })[0].state,
    "ok"
  );

  evaluation.stop();
  notification.stop();
  snapshot = getWorkerHeartbeatSnapshot({ now: current, staleAfterMs: 60000 });
  assert.equal(snapshot.every((worker) => worker.state === "stopped"), true);
  resetWorkerHealthForTests();
});

test("a busy worker is healthy only within its configured lease-progress window", () => {
  resetWorkerHealthForTests();
  let current = new Date("2026-08-14T12:00:00.000Z");
  const evaluation = createWorkerMonitor("evaluation", {
    busyStaleAfterMs: 120000,
    now: () => new Date(current),
  });
  const notification = createWorkerMonitor("notification", {
    now: () => new Date(current),
  });
  evaluation.cycleStarted();

  current = new Date(current.getTime() + 61000);
  assert.equal(
    getWorkerHeartbeatSnapshot({ now: current, staleAfterMs: 60000 })[0].state,
    "ok"
  );
  current = new Date(current.getTime() + 60000);
  assert.equal(
    getWorkerHeartbeatSnapshot({ now: current, staleAfterMs: 60000 })[0].state,
    "stale"
  );
  evaluation.progress("database_write_completed");
  assert.equal(
    getWorkerHeartbeatSnapshot({ now: current, staleAfterMs: 60000 })[0].state,
    "ok"
  );

  evaluation.stop();
  notification.stop();
  resetWorkerHealthForTests();
});

test("queue metrics expose only age and readiness fails only at critical age", async () => {
  resetWorkerHealthForTests();
  const now = new Date("2026-08-14T12:00:00.000Z");
  const evaluation = createWorkerMonitor("evaluation", { now: () => now });
  const notification = createWorkerMonitor("notification", { now: () => now });
  const db = queueDb({
    evaluation_jobs: { _id: "private-job-id", created_at: new Date(now.getTime() - 20 * 60 * 1000) },
    "_private_checkout_outbox": {
      _id: "private-attendance-id",
      _private_checkout_outbox: { created_at: new Date(now.getTime() - 5 * 60 * 1000) },
    },
  });

  const metrics = await getQueueAgeMetrics(db, { now });
  const evaluationMetric = metrics.find((item) => item.name === "evaluation_jobs");
  assert.equal(evaluationMetric.warning, true);
  assert.equal(evaluationMetric.critical, false);
  assert.equal(JSON.stringify(metrics).includes("private-job-id"), false);
  assert.equal((await getWorkerReadiness(db, { now })).ready, true);

  const strict = await getWorkerReadiness(db, {
    now,
    criticalAgeMs: 10 * 60 * 1000,
  });
  assert.equal(strict.ready, false);
  assert.ok(strict.reasons.includes("QUEUE_EVALUATION_JOBS_CRITICAL_AGE"));

  const nearPrivacyDeadline = queueDb({
    evaluation_jobs: {
      created_at: new Date(now.getTime() - 23 * 60 * 60 * 1000),
    },
  });
  const deadlineReadiness = await getWorkerReadiness(nearPrivacyDeadline, { now });
  assert.equal(deadlineReadiness.ready, false);
  assert.ok(deadlineReadiness.reasons.includes("QUEUE_EVALUATION_JOBS_CRITICAL_AGE"));

  const invalidTimestamp = await getQueueAgeMetrics(queueDb({
    notification_jobs: { created_at: "invalid" },
  }), { now });
  const invalidMetric = invalidTimestamp.find((item) => item.name === "notification_jobs");
  assert.equal(invalidMetric.invalid_timestamp, true);
  assert.equal(invalidMetric.critical, true);
  evaluation.stop();
  notification.stop();
  resetWorkerHealthForTests();
});
