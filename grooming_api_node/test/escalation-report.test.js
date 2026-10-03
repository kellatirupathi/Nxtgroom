import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  escalationReport,
  EscalationWeekError,
  requestedWeekStart,
  weekdayOf,
} from "../src/services/escalationReport.js";

/**
 * The Escalations page behind "View all" on the Dashboard: the runs of three
 * or more non-compliant check-ins in a row, one row per day, by the same rule
 * that emails the reporting partners.
 */

function matches(doc, filter = {}) {
  for (const [key, condition] of Object.entries(filter)) {
    const value = doc[key];
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      for (const [op, arg] of Object.entries(condition)) {
        if (op === "$in" && !arg.some((item) => String(item) === String(value))) return false;
        if (op === "$exists" && (value !== undefined) !== arg) return false;
        if (op === "$type" && typeof value !== arg) return false;
      }
    } else if (String(value) !== String(condition)) {
      return false;
    }
  }
  return true;
}

function memoryDb(collections) {
  return {
    collection(name) {
      return {
        find(filter) {
          const rows = (collections[name] || []).filter((doc) => matches(doc, filter));
          return { toArray: async () => rows.map((row) => ({ ...row })) };
        },
      };
    },
  };
}

const day = (id, instructor, dayKey, extra = {}) => ({
  _id: id,
  instructor_id: instructor,
  college_id: "c1",
  attendance_day: dayKey,
  check_in_time: new Date(`${dayKey}T03:40:00Z`),
  check_out_time: null,
  status: "compliant",
  ...extra,
});
const fail = { status: "non_compliant", remarks: "Shirt not tucked in." };

const collections = () => ({
  instructors: [
    { _id: "i1", name: "Ravi Teja", instructor_role: "INSTRUCTOR", college_id: "c1", report_token: "tokRavi" },
    { _id: "i2", name: "Asha", college_id: "c2", report_token: "tokAsha" },
    { _id: "i3", name: "Kiran", college_id: "c1" },
  ],
  colleges: [{ _id: "c1", name: "NIAT Hyderabad" }, { _id: "c2", name: "Aditya University" }],
  attendance: [
    // Ravi: Mon, (Tue absent), Wed, Thu failed - escalated, Tuesday skipped.
    day("r-mon", "i1", "2026-09-21", { ...fail, check_in_photo_key: "in/r-mon.jpg" }),
    day("r-wed", "i1", "2026-09-23", fail),
    day("r-thu", "i1", "2026-09-24", {
      ...fail,
      check_out_time: new Date("2026-09-24T12:30:00Z"),
      checkout_compliance_status: "COMPLIANT",
      check_in_photo_key: "in/r-thu.jpg",
      check_out_photo_key: "out/r-thu.jpg",
    }),
    // Asha: three in a row at another institute.
    day("a-tue", "i2", "2026-09-22", { ...fail, college_id: "c2" }),
    day("a-wed", "i2", "2026-09-23", { ...fail, college_id: "c2" }),
    day("a-thu", "i2", "2026-09-24", { ...fail, college_id: "c2", check_out_time: new Date("2026-09-24T12:00:00Z"), checkout_compliance_status: "NON_COMPLIANT" }),
    // Kiran: a pass breaks the run - not escalated.
    day("k-mon", "i3", "2026-09-21", fail),
    day("k-tue", "i3", "2026-09-22"),
    day("k-wed", "i3", "2026-09-23", fail),
    day("k-thu", "i3", "2026-09-24", fail),
    // Last week's failures never count towards this week.
    day("r-last", "i1", "2026-09-20", fail),
  ],
});

test("the week is any day in it, this week by default, and a bad date is refused", () => {
  assert.equal(requestedWeekStart("2026-09-24"), "2026-09-21");
  assert.equal(requestedWeekStart("2026-09-21"), "2026-09-21");
  assert.equal(requestedWeekStart("2026-09-27"), "2026-09-21", "Sunday ends the week");
  assert.equal(requestedWeekStart(undefined, new Date("2026-10-03T06:00:00Z")), "2026-09-28");
  assert.throws(() => requestedWeekStart("24-09-2026"), EscalationWeekError);
  assert.throws(() => requestedWeekStart("2026-13-40"), EscalationWeekError);
  assert.equal(weekdayOf("2026-09-24"), "Thursday");
});

test("one row per failed day of each escalated run, with both halves and their links", async () => {
  const report = await escalationReport(memoryDb(collections()), { week: "2026-09-24" });
  assert.equal(report.week_start, "2026-09-21");
  assert.equal(report.week_end, "2026-09-27");
  assert.deepEqual(report.rows.map((row) => `${row.name} ${row.date} ${row.weekday}`), [
    "Asha 2026-09-22 Tuesday",
    "Asha 2026-09-23 Wednesday",
    "Asha 2026-09-24 Thursday",
    "Ravi Teja 2026-09-21 Monday",
    "Ravi Teja 2026-09-23 Wednesday",
    "Ravi Teja 2026-09-24 Thursday",
  ]);
  const thursday = report.rows.find((row) => row.attendance_id === "r-thu");
  assert.deepEqual(
    {
      institute: thursday.institute,
      role: thursday.role,
      run: `${thursday.run_day} of ${thursday.run_length}`,
      run_start: thursday.run_start,
      check_in_status: thursday.check_in_status,
      check_out_status: thursday.check_out_status,
      photos: [thursday.has_checkin_photo, thursday.has_checkout_photo],
      token: thursday.report_token,
      remarks: thursday.check_in_remarks,
    },
    {
      institute: "NIAT Hyderabad",
      role: "INSTRUCTOR",
      run: "3 of 3",
      run_start: "2026-09-21",
      check_in_status: "non_compliant",
      check_out_status: "compliant",
      photos: [true, true],
      token: "tokRavi",
      remarks: "Shirt not tucked in.",
    },
  );
  const monday = report.rows.find((row) => row.attendance_id === "r-mon");
  assert.equal(monday.check_out_status, null, "no check-out that day");
  assert.equal(monday.check_out_time, null);
  assert.equal(report.rows.find((row) => row.attendance_id === "a-thu").check_out_status, "non_compliant");
  assert.ok(!report.rows.some((row) => row.name === "Kiran"), "a pass broke Kiran's run");
  assert.deepEqual(report.institutes, [{ id: "c2", name: "Aditya University" }, { id: "c1", name: "NIAT Hyderabad" }]);
});

test("one institute only, and an empty week", async () => {
  const one = await escalationReport(memoryDb(collections()), { week: "2026-09-24", collegeId: "c2" });
  assert.deepEqual([...new Set(one.rows.map((row) => row.name))], ["Asha"]);

  const empty = await escalationReport(memoryDb(collections()), { week: "2026-09-14" });
  assert.deepEqual(empty, { week_start: "2026-09-14", week_end: "2026-09-20", rows: [], institutes: [] });
});

test("the page is served to administrators only, under the Dashboard", async () => {
  const source = await readFile(new URL("../src/routes/dashboardRoutes.js", import.meta.url), "utf8");
  assert.match(source, /dashboardRouter\.get\(\s*"\/escalations",\s*requireSuperAdmin,/);
  assert.match(source, /escalationReport\(req\.app\.locals\.db, \{ week, collegeId \}\)/);
});
