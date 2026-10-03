import { runtimeConfig } from "../config/env.js";
import { idMatch } from "../middleware/auth.js";
import { localDateKey } from "./instructorReports.js";
import {
  addDaysToKey,
  ESCALATION_THRESHOLD,
  failedDayStreaks,
  weekStartKey,
} from "./evaluationWorker.js";

/**
 * The Escalations page: every run of three or more non-compliant check-ins in
 * a row in one Monday-to-Sunday week, one row per day of the run, with that
 * day's check-in and check-out, their verdicts, and what the page needs to
 * show their photographs and reports.
 *
 * The runs are found by failedDayStreaks, the function that sends reporting
 * partners the URGENT email, so the page lists exactly who was emailed about.
 * An instructor with two separate runs in a week appears for both.
 */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export class EscalationWeekError extends Error {}

/** The weekday of a YYYY-MM-DD key. */
export function weekdayOf(dayKey) {
  const [year, month, day] = String(dayKey).split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/** The Monday of the requested week: any day in it, or this week by default. */
export function requestedWeekStart(week, now = new Date()) {
  if (week === undefined || week === null || week === "") {
    return weekStartKey(localDateKey(now, runtimeConfig().appTimeZone));
  }
  if (typeof week !== "string" || !DAY_KEY.test(week) || Number.isNaN(Date.parse(`${week}T00:00:00Z`))) {
    throw new EscalationWeekError("week must be a date as YYYY-MM-DD");
  }
  return weekStartKey(week);
}

/** "compliant", "non_compliant", or the record's own word for anything else. */
function checkInVerdict(status) {
  const value = String(status || "").toLowerCase();
  if (["compliant", "done", "needs_review", "review_required"].includes(value)) return "compliant";
  if (["non_compliant", "fail"].includes(value)) return "non_compliant";
  return value || "pending";
}

function checkOutVerdict(record) {
  if (!record.check_out_time || record.checkout_deleting_at) return null;
  const value = String(record.checkout_compliance_status || "").toUpperCase();
  if (value === "COMPLIANT") return "compliant";
  if (value === "NON_COMPLIANT") return "non_compliant";
  if (value === "UNASSESSED") return "unassessed";
  if (value === "ERROR") return "error";
  return record.check_out_photo_key ? "pending" : "no_photo";
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * The rows for one week. `collegeId` narrows them to one institute. Rows are
 * ordered by instructor, then by day.
 */
export async function escalationReport(db, { week, collegeId = null, now = new Date() } = {}) {
  const weekStart = requestedWeekStart(week, now);
  const weekEnd = addDaysToKey(weekStart, 6);
  const days = Array.from({ length: 7 }, (_, offset) => addDaysToKey(weekStart, offset));

  const records = await db.collection("attendance").find(
    {
      attendance_day: { $in: days },
      instructor_id: { $type: "string" },
      deleting_at: { $exists: false },
    },
    {
      projection: {
        instructor_id: 1,
        instructor_name: 1,
        instructor_role: 1,
        college_id: 1,
        attendance_day: 1,
        check_in_time: 1,
        check_out_time: 1,
        status: 1,
        remarks: 1,
        checkout_compliance_status: 1,
        checkout_remarks: 1,
        checkout_deleting_at: 1,
        check_in_photo_key: 1,
        check_out_photo_key: 1,
      },
    }
  ).toArray();

  const byInstructor = new Map();
  for (const record of records) {
    const id = String(record.instructor_id);
    if (!byInstructor.has(id)) byInstructor.set(id, []);
    byInstructor.get(id).push(record);
  }

  const runs = [];
  for (const [instructorId, group] of byInstructor) {
    for (const streak of failedDayStreaks(group, weekStart)) {
      if (streak.length >= ESCALATION_THRESHOLD) runs.push({ instructorId, streak });
    }
  }
  if (!runs.length) {
    return { week_start: weekStart, week_end: weekEnd, rows: [], institutes: [] };
  }

  const instructorIds = [...new Set(runs.map((run) => run.instructorId))];
  const instructors = await db.collection("instructors").find(
    { _id: { $in: instructorIds.flatMap((id) => idMatch(id).$in) } },
    { projection: { name: 1, role: 1, instructor_role: 1, college_id: 1, report_token: 1 } }
  ).toArray();
  const instructorById = new Map(instructors.map((row) => [String(row._id), row]));

  const collegeIds = [...new Set(runs.flatMap(({ instructorId, streak }) => streak.map((record) => (
    record.college_id || instructorById.get(instructorId)?.college_id
  ))).filter(Boolean).map(String))];
  const colleges = collegeIds.length
    ? await db.collection("colleges").find(
      { _id: { $in: collegeIds.flatMap((id) => idMatch(id).$in) } },
      { projection: { name: 1 } }
    ).toArray()
    : [];
  const collegeName = new Map(colleges.map((row) => [String(row._id), row.name]));

  const rows = [];
  for (const { instructorId, streak } of runs) {
    const instructor = instructorById.get(instructorId);
    streak.forEach((record, index) => {
      const college = record.college_id || instructor?.college_id || null;
      if (collegeId && String(college || "") !== String(collegeId)) return;
      rows.push({
        attendance_id: String(record._id),
        instructor_id: instructorId,
        name: record.instructor_name || instructor?.name || "Unknown",
        role: record.instructor_role || instructor?.instructor_role || instructor?.role || null,
        college_id: college ? String(college) : null,
        institute: college ? (collegeName.get(String(college)) || "Unknown institute") : "No institute",
        date: record.attendance_day,
        weekday: weekdayOf(record.attendance_day),
        // Which failed check-in of the run this is, and how long the run is.
        run_day: index + 1,
        run_length: streak.length,
        run_start: streak[0].attendance_day,
        check_in_time: iso(record.check_in_time),
        check_in_status: checkInVerdict(record.status),
        check_in_remarks: record.remarks || null,
        check_out_time: record.checkout_deleting_at ? null : iso(record.check_out_time),
        check_out_status: checkOutVerdict(record),
        check_out_remarks: record.checkout_deleting_at ? null : (record.checkout_remarks || null),
        has_checkin_photo: Boolean(record.check_in_photo_key),
        has_checkout_photo: Boolean(record.check_out_photo_key && !record.checkout_deleting_at),
        report_token: instructor?.report_token || null,
      });
    });
  }
  rows.sort((left, right) => left.name.localeCompare(right.name)
    || left.instructor_id.localeCompare(right.instructor_id)
    || left.date.localeCompare(right.date));

  const institutes = [...new Map(rows
    .filter((row) => row.college_id)
    .map((row) => [row.college_id, { id: row.college_id, name: row.institute }])).values()]
    .sort((left, right) => left.name.localeCompare(right.name));
  return { week_start: weekStart, week_end: weekEnd, rows, institutes };
}
