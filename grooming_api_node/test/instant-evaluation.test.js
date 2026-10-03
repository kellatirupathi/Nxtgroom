import assert from "node:assert/strict";
import { test } from "node:test";
import { onEvaluationQueued } from "../src/services/evaluationWorker.js";

function fakeDb() {
  const jobs = new Map();
  return {
    collection(name) {
      if (name === "evaluation_jobs") {
        return {
          async updateOne(filter, update, options = {}) {
            if (!jobs.has(filter._id) && options.upsert) {
              jobs.set(filter._id, { ...(update.$setOnInsert || {}) });
            }
            return { matchedCount: 1 };
          },
          async findOne(filter) {
            return jobs.get(filter._id) || null;
          },
        };
      }
      return { async updateOne() { return { matchedCount: 1 }; } };
    },
  };
}

const payload = () => ({
  attendanceId: "a1",
  instructor: { id: "i1", name: "Asha", email: "a@example.com", gender: "FEMALE" },
  photoKey: "attendance/2026/09/10/a1-checkin.jpg",
  mimeType: "image/jpeg",
  checkInTime: new Date(),
  deadlineAt: new Date(Date.now() + 3600_000),
});

test("queueing a check-in signals a waiting worker", async () => {
  const { enqueueEvaluation } = await import("../src/services/evaluationWorker.js");
  let woken = 0;
  const stop = onEvaluationQueued(() => { woken += 1; });
  try {
    await enqueueEvaluation(fakeDb(), payload());
    assert.equal(woken, 1, "an idle worker must not wait for its next poll");
  } finally {
    stop();
  }
});

test("the signal arrives after the job is readable, not before", async () => {
  const { enqueueEvaluation } = await import("../src/services/evaluationWorker.js");
  const db = fakeDb();
  let jobVisibleWhenWoken = null;
  const stop = onEvaluationQueued(async () => {
    jobVisibleWhenWoken = await db.collection("evaluation_jobs").findOne({ _id: "a1:evaluation" });
  });
  try {
    await enqueueEvaluation(db, payload());
    assert.ok(jobVisibleWhenWoken, "the job must exist by the time the worker is woken");
  } finally {
    stop();
  }
});

test("a listener that throws cannot fail the check-in", async () => {
  const { enqueueEvaluation } = await import("../src/services/evaluationWorker.js");
  const stop = onEvaluationQueued(() => { throw new Error("worker exploded"); });
  try {
    await enqueueEvaluation(fakeDb(), payload());
  } finally {
    stop();
  }
});

test("unsubscribing stops the signal", async () => {
  const { enqueueEvaluation } = await import("../src/services/evaluationWorker.js");
  let woken = 0;
  const stop = onEvaluationQueued(() => { woken += 1; });
  stop();
  await enqueueEvaluation(fakeDb(), payload());
  assert.equal(woken, 0, "a stopped worker must not be signalled");
});
