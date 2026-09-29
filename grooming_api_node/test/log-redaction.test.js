import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app, loggedPath } from "../server.js";

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

test("a password-reset or invitation token never reaches the log", () => {
  const token = "tokentokentokentoken";
  assert.equal(
    loggedPath(`/api/v2/auth/reset-password/${token}`),
    "/api/v2/auth/reset-password/<token>"
  );
  // The POST that completes a reset has no token in its path.
  assert.equal(loggedPath("/api/v2/auth/reset-password"), "/api/v2/auth/reset-password");
});

test("paths outside the report prefix are untouched", () => {
  for (const path of ["/api/v2/attendance/today", "/health/ready", "/api/v2/auth/login", "/"]) {
    assert.equal(loggedPath(path), path);
  }
});

/**
 * The request log is written when the response finishes. By then a mounted
 * router has cut its prefix off req.path, so a report request was logged as
 * "/<token>/day/..." and slipped past the redaction above, which only matches
 * the full "/api/v2/reports/..." path. These go through the real middleware.
 */
let server;
let baseUrl;

before(async () => {
  app.locals.db = null;
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function requestLogFor(path) {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const response = await fetch(`${baseUrl}${path}`);
    await response.arrayBuffer();
    // The log line is written on "finish", which can land just after the
    // client has the body.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    console.log = originalLog;
  }
  return lines
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .find((entry) => entry.event === "http_request");
}

test("a report request handled inside its router logs the full path with the token hidden", async () => {
  const token = "tokentokentokentoken";
  const entry = await requestLogFor(`/api/v2/reports/${token}/day/2026-01-05/check-in`);
  assert.ok(entry, "no request log line was written");
  assert.equal(entry.path, "/api/v2/reports/<token>/day/2026-01-05/check-in");
});

test("a reset link handled inside its router logs the full path with the token hidden", async () => {
  const token = "tokentokentokentoken";
  const entry = await requestLogFor(`/api/v2/auth/reset-password/${token}`);
  assert.ok(entry, "no request log line was written");
  assert.equal(entry.path, "/api/v2/auth/reset-password/<token>");
});
