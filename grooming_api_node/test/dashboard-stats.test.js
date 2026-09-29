import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arrivalSlots,
  buildInstituteRows,
  checkpointAudience,
  countWorkingDays,
  instituteGroupsFromRecords,
  dashboardStatus,
  previousWorkingDayKey,
  workingDayKeys,
} from "../src/services/dashboardStats.js";

const ZONE = "Asia/Kolkata";
// Tuesday 29 September 2026, 5:20 PM in Kolkata.
const NOW = new Date("2026-09-29T11:50:00Z");
const TODAY = "2026-09-29";
const MONDAY = "2026-09-28";

/** A local wall-clock time on a day, as the UTC instant the database stores. */
const at = (day, time) => new Date(`${day}T${time}:00+05:30`);

const colleges = [
  { _id: "c1", name: "Hyderabad Campus" },
  { _id: "c2", name: "Warangal Campus" },
];
const roster = [
  { _id: "i1", name: "Ravi", college_id: "c1", gender: "MALE" },
  { _id: "i2", name: "Priya", college_id: "c1", gender: "FEMALE" },
  { _id: "i3", name: "Suresh", college_id: "c2", gender: "male" },
  { _id: "i4", name: "Lakshmi", college_id: "c2", gender: "female" },
];

const record = (id, instructor, day, time, extra = {}) => ({
  _id: id,
  instructor_id: instructor,
  college_id: roster.find((row) => row._id === instructor)?.college_id ?? "c1",
  attendance_day: day,
  date: at(day, time),
  check_in_time: at(day, time),
  check_out_time: null,
  status: "compliant",
  ...extra,
});

const weekRecords = [
  // Today.
  record("t1", "i1", TODAY, "08:50", { status: "non_compliant", check_out_time: at(TODAY, "17:05") }),
  record("t2", "i2", TODAY, "08:52", { status: "compliant", attire_type: "SAREE", image_quality: "RETAKE_RECOMMENDED" }),
  record("t3", "i3", TODAY, "09:10", { status: "pending" }),
  record("t4", null, TODAY, "09:11", { college_id: "c2", status: "unidentified" }),
  // Monday: i1 fails twice (check-in and check-out), i4 is on a kurti.
  record("m1", "i1", MONDAY, "08:40", {
    status: "non_compliant",
    check_out_time: at(MONDAY, "17:00"),
    checkout_compliance_status: "NON_COMPLIANT",
  }),
  record("m2", "i4", MONDAY, "08:45", { attire_type: "KURTI_WITH_DUPATTA" }),
  // Men's evaluations are recorded as FORMAL and must not count as women's attire.
  record("m3", "i3", MONDAY, "08:47", { attire_type: "FORMAL", check_out_time: at(MONDAY, "17:10") }),
  // Last Saturday: the previous working day for a Monday, but not for today.
  record("s1", "i2", "2026-09-26", "08:30"),
];

test("statuses are read exactly as the Daily Records badge reads them", () => {
  assert.equal(dashboardStatus("compliant"), "compliant");
  assert.equal(dashboardStatus("DONE"), "compliant");
  assert.equal(dashboardStatus("needs_review"), "compliant");
  assert.equal(dashboardStatus("review_required"), "compliant");
  assert.equal(dashboardStatus("fail"), "non_compliant");
  assert.equal(dashboardStatus("non_compliant"), "non_compliant");
  assert.equal(dashboardStatus("unassessed"), "unassessed");
  assert.equal(dashboardStatus("unidentified"), "unidentified");
  assert.equal(dashboardStatus("error"), "error");
  assert.equal(dashboardStatus(undefined), "pending");
  assert.equal(dashboardStatus("pending"), "pending");
});

test("the working week is Monday to Saturday", () => {
  const keys = workingDayKeys(TODAY, 8);
  assert.equal(keys.length, 8);
  assert.equal(keys.at(-1), TODAY);
  assert.ok(!keys.includes("2026-09-27"), "Sunday is never a working day");
  // 29, 28, 26, 25, 24, 23, 22, 21: Sunday the 27th is skipped.
  assert.equal(keys[0], "2026-09-21");
  assert.equal(previousWorkingDayKey(TODAY), MONDAY);
  assert.equal(previousWorkingDayKey(MONDAY), "2026-09-26", "Monday's previous working day is Saturday");
});

test("checkpoints are labelled with who they apply to", () => {
  assert.equal(checkpointAudience("ID_PRESENT"), "All");
  assert.equal(checkpointAudience("M_BELT"), "Men");
  assert.equal(checkpointAudience("W_SAREE_BLOUSE"), "Saree");
  assert.equal(checkpointAudience("W_DUPATTA"), "Kurti");
  assert.equal(checkpointAudience("W_BOTTOM_WEAR"), "Kurti");
  assert.equal(checkpointAudience("W_FORMAL_TOP"), "Formal");
  assert.equal(checkpointAudience("W_HAIR_NEATNESS"), "Women");
});

test("check-ins are bucketed by local quarter hour with empty slots kept", () => {
  const slots = arrivalSlots(
    [
      { check_in_time: at(TODAY, "08:50") },
      { check_in_time: at(TODAY, "08:52") },
      { check_in_time: at(TODAY, "09:31") },
    ],
    ZONE
  );
  assert.deepEqual(slots.map((slot) => [slot.label, slot.count]), [
    ["8:45 AM", 2],
    ["9:00 AM", 0],
    ["9:15 AM", 0],
    ["9:30 AM", 1],
  ]);
  assert.equal(slots[0].end_label, "9:00 AM");
  assert.deepEqual(arrivalSlots([], ZONE), []);
});

test("working days in a range skip Sundays, and a lone Sunday still counts once", () => {
  assert.equal(countWorkingDays("2026-09-28", "2026-09-28"), 1);
  assert.equal(countWorkingDays("2026-09-21", "2026-09-27"), 6, "Monday to Sunday is six working days");
  assert.equal(countWorkingDays("2026-09-27", "2026-09-27"), 1, "a chosen Sunday is measured as one day");
  assert.equal(countWorkingDays("2026-09-01", "2026-09-30"), 26);
  assert.equal(countWorkingDays("2026-09-30", "2026-09-01"), 0);
});

test("over several days, present counts instructor-days against roster times working days", () => {
  const groups = instituteGroupsFromRecords(weekRecords.filter((row) => row.attendance_day >= MONDAY));
  const [hyderabad, warangal] = buildInstituteRows({ colleges, roster, groups, workingDays: 2 });
  // Hyderabad: i1 and i2 today, i1 Monday.
  assert.deepEqual([hyderabad.present, hyderabad.expected, hyderabad.present_percent], [3, 4, 75]);
  assert.deepEqual([hyderabad.compliant, hyderabad.non_compliant], [1, 2]);
  // Warangal: i3 today and Monday, i4 Monday, plus one unnamed arrival.
  assert.deepEqual([warangal.present, warangal.expected, warangal.unidentified], [3, 4, 1]);
});
