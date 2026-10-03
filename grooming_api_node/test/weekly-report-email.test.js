import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildWeeklyReportEmail } from "../src/services/emailService.js";
import { summariseWeek } from "../src/services/instructorReports.js";

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

  assert.match(email.text, /Compliant: 0/);
  assert.match(email.text, /Non-compliant: 0/);
});

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

test("a notification whose lease is lost after sending is settled, not sent again", async () => {
  const source = await readFile(
    new URL("../src/services/notificationWorker.js", import.meta.url),
    "utf8",
  );
  const deliver = source.slice(
    source.indexOf("async function deliverNotification"),
    source.indexOf("export async function reconcileOverdueNotificationJobs"),
  );
  assert.ok(deliver.length > 0, "deliverNotification must remain identifiable");

  assert.doesNotMatch(
    deliver,
    /throw new Error\("Notification delivery lease was lost/,
    "a delivered email must never be thrown back into the retry path",
  );
  assert.match(
    deliver,
    /lease_lost_after_send: true/,
    "the lost lease is recorded so the settle is distinguishable from a normal one",
  );
  assert.match(deliver, /failure\.code = result\.reason/, "a refused send still throws");
});
