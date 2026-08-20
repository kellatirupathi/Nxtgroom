import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isValidDateKey,
  summariseWeek,
  weekStartKey,
  workingWeekDates,
} from "../src/services/instructorReports.js";
import { isValidRecipient, normaliseEmail } from "../src/services/reportRecipients.js";

test("Sunday belongs to the week that just ended", () => {
  // The weekly email goes out on Sunday morning and must summarise the six
  // days behind it, not the week about to start.
  assert.equal(weekStartKey(new Date("2026-08-23T10:00:00+05:30")), "2026-08-17");
  assert.equal(weekStartKey(new Date("2026-08-17T09:00:00+05:30")), "2026-08-17", "Monday");
  assert.equal(weekStartKey(new Date("2026-08-22T23:00:00+05:30")), "2026-08-17", "Saturday");
  assert.equal(weekStartKey(new Date("2026-08-24T09:00:00+05:30")), "2026-08-24", "next Monday");
});

test("a working week is six days and excludes Sunday", () => {
  const dates = workingWeekDates("2026-08-17");
  assert.equal(dates.length, 6);
  assert.deepEqual(dates, [
    "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22",
  ]);
  assert.equal(dates.includes("2026-08-23"), false, "Sunday is not a working day");
});

test("the summary counts attire and compliance per day", () => {
  const summary = summariseWeek([
    { _id: "a", check_in_time: "2026-08-17T04:00:00Z", status: "compliant", attire_type: "SAREE", check_out_time: "2026-08-17T12:00:00Z" },
    { _id: "b", check_in_time: "2026-08-18T04:00:00Z", status: "non_compliant", attire_type: "KURTI_WITH_DUPATTA", check_out_time: null },
    { _id: "c", check_in_time: "2026-08-19T04:00:00Z", status: "review_required", attire_type: "SAREE", check_out_time: "2026-08-19T12:00:00Z" },
  ], "2026-08-17");

  assert.equal(summary.days.length, 6, "always six rows, present or not");
  assert.equal(summary.present_days, 3);
  assert.equal(summary.saree_days, 2);
  assert.equal(summary.kurti_days, 1);
  // Two: the compliant day, plus a legacy review_required record, which was a
  // compliant result flagged under a rule that no longer exists.
  assert.equal(summary.compliant_days, 2);
  assert.equal(summary.non_compliant_days, 1);
  assert.equal(summary.missed_checkouts, 1, "b never checked out");
  assert.equal(summary.days[3].present, false, "Thursday is absent");
});

test("two check-ins on one day count once", () => {
  // Otherwise a re-check-in after a check-out would inflate the day count
  // past the six working days.
  const summary = summariseWeek([
    { _id: "a", check_in_time: "2026-08-17T04:00:00Z", status: "compliant", attire_type: "FORMAL" },
    { _id: "b", check_in_time: "2026-08-17T09:00:00Z", status: "non_compliant", attire_type: "FORMAL" },
  ], "2026-08-17");
  assert.equal(summary.present_days, 1);
  assert.equal(summary.days[0].attendance_id, "a", "the earliest check-in wins");
});

test("date keys are validated before they reach a query", () => {
  assert.equal(isValidDateKey("2026-08-17"), true);
  for (const bad of ["2026-8-17", "17-08-2026", "not-a-date", "", null, "2026-13-45", "2026-02-31"]) {
    assert.equal(isValidDateKey(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("recipient addresses are normalised and validated", () => {
  assert.equal(normaliseEmail("  RP@NxtWave.CO.in "), "rp@nxtwave.co.in");
  assert.equal(isValidRecipient("rp@nxtwave.co.in"), true);
  for (const bad of ["", "  ", "not-an-email", "a@b", null, undefined]) {
    assert.equal(isValidRecipient(bad), false);
  }
});
