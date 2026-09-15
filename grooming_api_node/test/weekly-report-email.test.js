import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildWeeklyReportEmail } from "../src/services/emailService.js";
import { summariseWeek } from "../src/services/instructorReports.js";

/**
 * The weekly summary is written from what summariseWeek produces, and only
 * that.
 *
 * It carried a "Needs review" figure for a status that evaluation no longer
 * assigns, so summariseWeek never counted one and the template interpolated
 * the missing field anyway. Nothing threw — template literals render undefined
 * as text — so every instructor read "Needs review: undefined" in both halves
 * of the mail, weekly, with no error anywhere to notice.
 */
test("the weekly summary interpolates nothing summariseWeek does not produce", () => {
  const summary = summariseWeek([], "2026-09-14");
  const email = buildWeeklyReportEmail({
    name: "Instructor",
    summary,
    reportUrl: "https://example.invalid/report",
  });

  const rendered = `${email.subject}\n${email.text}\n${email.html}`;
  assert.doesNotMatch(rendered, /undefined/, "a missing field must never reach the reader");
  assert.doesNotMatch(rendered, /Needs review/, "the removed status must not be labelled");

  // The counts that do exist are still reported, so this cannot pass by
  // rendering an empty summary.
  assert.match(email.text, /Compliant: 0/);
  assert.match(email.text, /Non-compliant: 0/);
});

/**
 * Every field the template reads must be one summariseWeek writes.
 *
 * Asserted against the real summary rather than a fixture: a fixture would
 * keep passing after summariseWeek stopped producing a field, which is exactly
 * how the "Needs review" line survived.
 */
test("a populated week renders every figure it claims to", () => {
  const day = (date, status, attire) => ({
    check_in_time: new Date(`${date}T03:30:00.000Z`),
    date: new Date(`${date}T03:30:00.000Z`),
    compliance_status: status,
    attire_type: attire,
  });
  const summary = summariseWeek(
    [day("2026-09-14", "COMPLIANT", "FORMAL"), day("2026-09-15", "NON_COMPLIANT", "SAREE")],
    "2026-09-14",
  );
  const email = buildWeeklyReportEmail({
    name: "Instructor",
    summary,
    reportUrl: "https://example.invalid/report",
  });

  const rendered = `${email.subject}\n${email.text}\n${email.html}`;
  assert.doesNotMatch(rendered, /undefined/);
  assert.doesNotMatch(rendered, /NaN/, "a count that failed to compute must not render either");
});

/**
 * The permission guard awaits, so it has to be wrapped.
 *
 * Express 4 does not catch a rejected promise returned by middleware. An
 * unwrapped guard therefore failed twice over: the caller received no reply
 * and hung until the socket was destroyed, and the rejection reached the
 * process-level unhandledRejection listener, which shuts the API down. The
 * guard reads access settings from the database on a thirty-second cache, so a
 * failover or a pool timeout was enough to turn one request for the
 * unidentified queue into an outage for everybody.
 *
 * Asserted against the source because the guard is module-private, and
 * exporting a three-line function to test it would widen the module's surface
 * for less than this costs.
 */
test("the identify guard is wrapped so a database fault cannot escape it", async () => {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");

  assert.match(
    source,
    /const requireIdentifyPermission = asyncRoute\(/,
    "the guard must be asyncRoute-wrapped",
  );
  assert.doesNotMatch(
    source,
    /async function requireIdentifyPermission/,
    "a bare async middleware leaves its rejection uncaught",
  );
});
