import assert from "node:assert/strict";
import { test } from "node:test";
import { loggedPath } from "../server.js";

/**
 * A public report URL carries the recipient's report token in its path, and
 * that token is the only credential protecting their photographs and their
 * whole report history. The request log recorded req.path verbatim, so every
 * report a recipient opened copied a working credential into the platform log
 * stream and everything downstream of it.
 */

test("a report token never reaches the log", () => {
  // Deliberately repetitive. The value is irrelevant to the assertion, and a
  // random-looking fixture reads to a secret scanner as a real credential.
  const token = "tokentokentokentoken";
  for (const path of [
    `/api/v2/reports/${token}/day/2026-01-05`,
    `/api/v2/reports/${token}/day/2026-01-05/check-out`,
    `/api/v2/reports/${token}/day/2026-01-05/photo/checkin`,
    `/api/v2/reports/${token}/week/2026-01-05`,
  ]) {
    const logged = loggedPath(path);
    assert.ok(!logged.includes(token), `${path} leaked its token`);
    assert.ok(logged.includes("<token>"));
  }
});

test("the rest of the path survives, so the log still says what was requested", () => {
  assert.equal(
    loggedPath("/api/v2/reports/AbC-tok_123/day/2026-01-05/check-out"),
    "/api/v2/reports/<token>/day/2026-01-05/check-out"
  );
});

test("cron paths under the same prefix stay readable", () => {
  // They carry no secret, and an operator needs to tell the scheduled jobs
  // apart in the log.
  for (const path of [
    "/api/v2/reports/cron/weekly-reports",
    "/api/v2/reports/cron/attendance-reminders",
    "/api/v2/reports/cron/purge-photos",
    "/api/v2/reports/cron/health",
  ]) {
    assert.equal(loggedPath(path), path);
  }
});

test("paths outside the report prefix are untouched", () => {
  for (const path of ["/api/v2/attendance/today", "/health/ready", "/api/v2/auth/login", "/"]) {
    assert.equal(loggedPath(path), path);
  }
});
