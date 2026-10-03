import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import {
  buildDashboard,
  buildInstituteRows,
  checkpointAudience,
  clearDashboardCache,
  countWorkingDays,
  DashboardRangeError,
  normalizeInstituteRange,
  dashboardStatus,
  previousWorkingDayKey,
  TREND_WORKING_DAYS,
  workingDayKeys,
} from "../src/services/dashboardStats.js";
import { dashboardRouter } from "../src/routes/dashboardRoutes.js";

const ZONE = "Asia/Kolkata";
const NOW = new Date("2026-09-29T11:50:00Z");
const TODAY = "2026-09-29";
const MONDAY = "2026-09-28";

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
  record("t1", "i1", TODAY, "08:50", { status: "non_compliant", check_out_time: at(TODAY, "17:05") }),
  record("t2", "i2", TODAY, "08:52", { status: "compliant" }),
  record("t3", "i3", TODAY, "09:10", { status: "pending" }),
  record("t4", null, TODAY, "09:11", { college_id: "c2", status: "unidentified" }),
  record("m1", "i1", MONDAY, "08:40", {
    status: "non_compliant",
    check_out_time: at(MONDAY, "17:00"),
    checkout_compliance_status: "NON_COMPLIANT",
  }),
  record("m2", "i4", MONDAY, "08:45"),
  record("m3", "i3", MONDAY, "08:47", { check_out_time: at(MONDAY, "17:10") }),
  record("s1", "i2", "2026-09-26", "08:30"),
];

const failedRows = [
  { attendance_id: "t1", kind: "checkin", code: "ID_PRESENT", name: "ID Card Present" },
  { attendance_id: "t1", kind: "checkin", code: "M_BELT", name: "Belt" },
  { attendance_id: "m1", kind: "checkin", code: "ID_PRESENT", name: "ID Card Present" },
  { attendance_id: "m1", kind: "checkout", code: "M_SHIRT_COLLAR_TUCK", name: "Shirt Collar / Tuck" },
  { attendance_id: "s1", kind: "checkin", code: "W_DUPATTA", name: "Dupatta" },
];

function build(extra = {}) {
  return buildDashboard({
    now: NOW,
    timeZone: ZONE,
    colleges,
    roster,
    weekRecords,
    trendRows: [
      { _id: TODAY, present: 3, compliant: 1, non_compliant: 1 },
      { _id: "2026-09-22", present: 4, compliant: 3, non_compliant: 1 },
    ],
    unidentifiedByCollege: [{ _id: "c2", count: 2 }, { _id: null, count: 1 }],
    failedRows,
    ...extra,
  });
}

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

test("today's summary counts identified check-ins against the roster", () => {
  const { summary, today, status_breakdown: breakdown } = build();
  assert.equal(today, TODAY);
  assert.equal(summary.total_instructors, 4);
  assert.equal(summary.present, 3);
  assert.equal(summary.not_checked_in, 1);
  assert.equal(summary.present_percent, 75);
  assert.equal(summary.check_ins, 3, "the unidentified arrival is not an instructor's check-in");
  assert.equal(summary.compliant, 1);
  assert.equal(summary.non_compliant, 1);
  assert.equal(summary.analysed, 2);
  assert.equal(summary.compliance_percent, 50);
  assert.equal(summary.pending, 1);
  assert.equal(summary.checked_out, 1);
  assert.equal(summary.on_duty, 2);
  assert.equal(summary.missed_checkout_previous_day, 1, "i4 never checked out on Monday");
  assert.equal("unidentified_waiting" in summary, false);
  assert.equal("unidentified_today" in summary, false);
  assert.deepEqual(breakdown.map((row) => [row.key, row.count]), [
    ["compliant", 1], ["unassessed", 0], ["non_compliant", 1], ["pending", 1], ["error", 0],
  ]);
});

test("compliance is compared with the same weekday last week", () => {
  const { summary, same_day_last_week: lastWeek } = build();
  assert.equal(lastWeek, "2026-09-22");
  assert.equal(summary.compliance_same_day_last_week, 75);
  assert.equal(build({ trendRows: [] }).summary.compliance_same_day_last_week, null);
});

test("the trend covers thirty working days and fills missing days with zero", () => {
  const { trend } = build();
  assert.equal(trend.length, TREND_WORKING_DAYS);
  assert.equal(trend.at(-1).day, TODAY);
  assert.equal(trend.at(-1).present_percent, 75);
  assert.equal(trend.at(-1).compliance_percent, 50);
  const quiet = trend.find((row) => row.day === "2026-09-23");
  assert.deepEqual(
    { present: quiet.present, compliance: quiet.compliance_percent },
    { present: 0, compliance: null },
    "a day with nothing analysed has no compliance rather than 0%"
  );
});

test("failed checkpoints count this week only, most frequent first", () => {
  const { failed_checkpoints: fails } = build();
  assert.deepEqual(fails.map((row) => [row.name, row.count, row.audience]), [
    ["ID Card Present", 2, "All"],
    ["Belt", 1, "Men"],
    ["Shirt Collar / Tuck", 1, "Men"],
  ]);
});

test("a check-out failure stops counting once that check-out is deleted", () => {
  const records = weekRecords.map((row) => (
    row._id === "m1" ? { ...row, checkout_deleting_at: new Date() } : row
  ));
  const names = build({ weekRecords: records }).failed_checkpoints.map((row) => row.name);
  assert.ok(!names.includes("Shirt Collar / Tuck"));
});

test("escalation uses the same rule as the URGENT email: check-in days in a row", () => {
  assert.equal(build().escalations.length, 0);
  const third = record("w1", "i1", "2026-09-30", "08:50", { status: "non_compliant" });
  const { escalations } = build({ weekRecords: [...weekRecords, third] });
  assert.equal(escalations.length, 1, "i1 failed at check-in on three days in a row");
  const [row] = escalations;
  assert.equal(row.instructor_id, "i1");
  assert.equal(row.name, "Ravi");
  assert.equal(row.college_name, "Hyderabad Campus");
  assert.equal(row.count, 3);
  assert.equal(row.top_checkpoint, "ID Card Present");
});

test("each institute reports its own day, mode and enrolment", () => {
  const [hyderabad, warangal] = buildInstituteRows({
    colleges,
    roster,
    identificationSettings: { default_mode: "FACE_ONLY", college_modes: { c2: "SELECTOR" } },
    enrolment: new Map([["c1", { total: 2, enrolled: 2 }], ["c2", { total: 2, enrolled: 1 }]]),
    groups: [
      { _id: "c1", check_ins: 2, compliant: 1, non_compliant: 1 },
      { _id: "c2", check_ins: 1, compliant: 0, non_compliant: 0, unidentified: 1 },
    ],
    workingDays: 1,
  });
  assert.deepEqual(
    {
      present: hyderabad.present,
      expected: hyderabad.expected,
      instructors: hyderabad.instructors,
      compliance: hyderabad.compliance_percent,
      mode: hyderabad.mode,
      enrolled: hyderabad.enrolled_percent,
      low: hyderabad.low_enrolment,
    },
    { present: 2, expected: 2, instructors: 2, compliance: 50, mode: "FACE_ONLY", enrolled: 100, low: false }
  );
  assert.equal(warangal.mode, "SELECTOR");
  assert.equal(warangal.present, 1);
  assert.equal(warangal.compliance_percent, null, "nothing analysed yet at Warangal today");
  assert.equal("unidentified" in warangal, false);
  assert.equal(warangal.enrolled_percent, 50);
  assert.equal(warangal.low_enrolment, false, "a SELECTOR college is never flagged, matching Settings");
});

test("working days in a range skip Sundays, and a lone Sunday still counts once", () => {
  assert.equal(countWorkingDays("2026-09-28", "2026-09-28"), 1);
  assert.equal(countWorkingDays("2026-09-21", "2026-09-27"), 6, "Monday to Sunday is six working days");
  assert.equal(countWorkingDays("2026-09-27", "2026-09-27"), 1, "a chosen Sunday is measured as one day");
  assert.equal(countWorkingDays("2026-09-01", "2026-09-30"), 26);
  assert.equal(countWorkingDays("2026-09-30", "2026-09-01"), 0);
});

test("a range is validated, and its end is held at today", () => {
  assert.deepEqual(normalizeInstituteRange({ from: "2026-09-23", to: "2026-09-29" }, TODAY), { from: "2026-09-23", to: TODAY });
  assert.deepEqual(normalizeInstituteRange({ from: "", to: "" }, TODAY), { from: "", to: TODAY }, "all time");
  assert.deepEqual(normalizeInstituteRange({ from: "2026-09-20", to: "2026-12-31" }, TODAY), { from: "2026-09-20", to: TODAY });
  assert.throws(() => normalizeInstituteRange({ from: "2026-09-29", to: "2026-09-01" }, TODAY), DashboardRangeError);
  assert.throws(() => normalizeInstituteRange({ from: "2026-10-05", to: "" }, TODAY), DashboardRangeError);
  assert.throws(() => normalizeInstituteRange({ from: "2026-02-30", to: "" }, TODAY), DashboardRangeError);
  assert.throws(() => normalizeInstituteRange({ from: "29-09-2026", to: "" }, TODAY), DashboardRangeError);
});

test("over several days, present counts instructor-days against roster times working days", () => {
  const groups = [
    { _id: "c1", check_ins: 3, compliant: 1, non_compliant: 2 },
    { _id: "c2", check_ins: 3, compliant: 2, non_compliant: 0, unidentified: 1 },
  ];
  const [hyderabad, warangal] = buildInstituteRows({ colleges, roster, groups, workingDays: 2 });
  assert.deepEqual([hyderabad.present, hyderabad.expected, hyderabad.present_percent], [3, 4, 75]);
  assert.deepEqual([hyderabad.compliant, hyderabad.non_compliant], [1, 2]);
  assert.deepEqual([warangal.present, warangal.expected], [3, 4]);
});

function emptyDb() {
  const cursor = (rows) => ({ sort: () => cursor(rows), toArray: async () => rows });
  return {
    collection(name) {
      return {
        find: () => cursor(name === "colleges" ? colleges : []),
        aggregate: () => ({ toArray: async () => [] }),
        findOne: async () => null,
      };
    },
  };
}

async function request(role, query = "") {
  clearDashboardCache();
  const app = express();
  app.locals.db = emptyDb();
  app.use((req, _res, next) => {
    req.currentUser = { email: "someone@example.com", role, collegeId: role === "BOA" ? "c1" : null };
    next();
  });
  app.use("/api/v2/dashboard", dashboardRouter);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/dashboard${query}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("only administrators can open the dashboard", async () => {
  assert.equal((await request("BOA")).status, 403);
  assert.equal((await request("ADMIN")).status, 200);
  const { status, body } = await request("SUPER_ADMIN");
  assert.equal(status, 200);
  assert.equal(body.summary.total_instructors, 0);
  assert.equal(body.institutes, undefined, "institutes come from /institutes, for Institute Analytics");
  assert.equal(body.trend.length, TREND_WORKING_DAYS);
});

test("the institutes range endpoint validates its dates", async () => {
  assert.equal((await request("BOA", "/institutes?from=2026-09-01&to=2026-09-02")).status, 403);
  const ok = await request("ADMIN", "/institutes?from=&to=");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.institutes.length, 2);
  assert.equal(ok.body.working_days >= 1, true);
  assert.equal((await request("ADMIN", "/institutes?from=2026-09-10&to=2026-09-01")).status, 422);
  assert.equal((await request("ADMIN", "/institutes?from=a&from=b")).status, 422);
  assert.equal((await request("ADMIN", "/institutes?from=not-a-date")).status, 422);
});

test("the institute filter is validated", async () => {
  assert.equal((await request("ADMIN", "?college_id=all")).status, 200);
  assert.equal((await request("ADMIN", "?college_id=a&college_id=b")).status, 422);
});
