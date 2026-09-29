import {
  addDaysToKey,
  ESCALATION_THRESHOLD,
  nonCompliantOccurrences,
  weekStartKey,
} from "./evaluationWorker.js";
import {
  describeCollegeIdentification,
} from "./identificationSettings.js";
import { localDateKey } from "./instructorReports.js";

/**
 * The administrators' Dashboard: today's attendance and grooming results, the
 * recent trend, and where attention is needed.
 *
 * Everything is derived from the records the rest of the application already
 * writes. Nothing here is stored, and no count is kept anywhere that could
 * drift from Daily Records: a status is read the same way the Daily Records
 * badge reads it, and an escalation is counted by the same function that sends
 * reporting partners the URGENT email.
 *
 * The work is split so the arithmetic can be tested without a database:
 * loadDashboard runs the queries, buildDashboard turns their rows into the
 * response.
 */

/** Working days shown on the trend chart. The page offers 7, 14 and 30. */
export const TREND_WORKING_DAYS = 30;
/** Rows in the most-failed checkpoints list. */
export const FAILED_CHECKPOINT_LIMIT = 8;
/** Width of one bar on the check-ins-by-time chart. */
export const ARRIVAL_SLOT_MINUTES = 15;

const COMPLIANT_STATUSES = new Set(["compliant", "done", "needs_review", "review_required"]);
const NON_COMPLIANT_STATUSES = new Set(["non_compliant", "fail"]);
const WOMENS_ATTIRE = ["SAREE", "KURTI_WITH_DUPATTA", "FORMAL"];

/**
 * One check-in's result, read exactly as the Daily Records badge reads it
 * (normalizeAttendanceStatus in the frontend), so the Dashboard and the table
 * can never count the same record differently.
 */
export function dashboardStatus(status) {
  const value = String(status || "").toLowerCase();
  if (COMPLIANT_STATUSES.has(value)) return "compliant";
  if (NON_COMPLIANT_STATUSES.has(value)) return "non_compliant";
  if (value === "unassessed") return "unassessed";
  if (value === "unidentified") return "unidentified";
  if (value === "error") return "error";
  return "pending";
}

function percent(part, whole) {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

function isSundayKey(dayKey) {
  const [year, month, day] = String(dayKey).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0;
}

/**
 * The last `count` working days ending with `todayKey`, oldest first.
 * The working week is Monday to Saturday, as in the weekly report.
 */
export function workingDayKeys(todayKey, count) {
  const keys = [];
  for (let offset = 0; keys.length < count && offset < count * 2 + 7; offset += 1) {
    const key = addDaysToKey(todayKey, -offset);
    if (!isSundayKey(key)) keys.unshift(key);
  }
  return keys;
}

/** The working day before `todayKey`: Saturday for a Monday. */
export function previousWorkingDayKey(todayKey) {
  let key = addDaysToKey(todayKey, -1);
  while (isSundayKey(key)) key = addDaysToKey(key, -1);
  return key;
}

/** Who a checkpoint applies to, from the code the checkpoint tables give it. */
export function checkpointAudience(code) {
  const value = String(code || "");
  if (value.startsWith("M_")) return "Men";
  if (value.startsWith("W_SAREE_")) return "Saree";
  if (value.startsWith("W_KURTI_") || value === "W_DUPATTA" || value === "W_BOTTOM_WEAR") return "Kurti";
  if (value.startsWith("W_FORMAL_")) return "Formal";
  if (value.startsWith("W_")) return "Women";
  return "All";
}

function dayKeyOf(record, timeZone) {
  if (record.attendance_day) return String(record.attendance_day);
  const moment = record.check_in_time || record.date;
  return moment ? localDateKey(new Date(moment), timeZone) : null;
}

function identified(record) {
  return record.instructor_id != null && record.instructor_id !== "";
}

/** Minutes past local midnight, in the application's time zone. */
function localMinutes(moment, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(moment)).map((part) => [part.type, part.value])
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function clockLabel(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour < 12 ? "AM" : "PM";
  return `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/**
 * Check-ins per slot today, from the first occupied slot to the last, with the
 * empty slots between them kept so the chart's time axis stays even.
 */
export function arrivalSlots(records, timeZone, slotMinutes = ARRIVAL_SLOT_MINUTES) {
  const counts = new Map();
  for (const record of records) {
    if (!record.check_in_time) continue;
    const slot = Math.floor(localMinutes(record.check_in_time, timeZone) / slotMinutes);
    counts.set(slot, (counts.get(slot) || 0) + 1);
  }
  if (!counts.size) return [];
  const slots = [...counts.keys()];
  const first = Math.min(...slots);
  const last = Math.max(...slots);
  const result = [];
  for (let slot = first; slot <= last; slot += 1) {
    const start = slot * slotMinutes;
    result.push({
      start_minutes: start,
      label: clockLabel(start),
      end_label: clockLabel(Math.min(start + slotMinutes, 24 * 60 - 1)),
      count: counts.get(slot) || 0,
    });
  }
  return result;
}

function mostFrequent(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let best = null;
  for (const [value, count] of counts) {
    if (!best || count > best.count) best = { value, count };
  }
  return best?.value ?? null;
}

/**
 * Mon–Sat days from `fromKey` to `toKey`, both inclusive. A range that holds
 * no working day at all - a single Sunday someone chose - counts as the one
 * day it is, so its check-ins are still measured against the roster.
 */
export function countWorkingDays(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey > toKey) return 0;
  let count = 0;
  let calendarDays = 0;
  for (let key = fromKey; key <= toKey; key = addDaysToKey(key, 1)) {
    calendarDays += 1;
    if (!isSundayKey(key)) count += 1;
  }
  return count || (calendarDays ? 1 : 0);
}

/**
 * Per-institute totals from attendance records, in the shape the database
 * aggregation in loadInstituteStats returns, so today's table and a chosen
 * range are built by the same function.
 */
export function instituteGroupsFromRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const key = record.college_id == null ? "" : String(record.college_id);
    const group = groups.get(key) || { _id: key, check_ins: 0, compliant: 0, non_compliant: 0, unidentified: 0 };
    const status = dashboardStatus(record.status);
    if (identified(record)) {
      group.check_ins += 1;
      if (status === "compliant") group.compliant += 1;
      if (status === "non_compliant") group.non_compliant += 1;
    } else if (status === "unidentified") {
      group.unidentified += 1;
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * One row per active institute for the Institutes table.
 *
 * `present` counts instructor-days: one per instructor per day they checked
 * in, which the one-record-per-day rule makes the same as their identified
 * check-ins. `expected` is the roster times the working days in the range, so
 * over one day the column reads "present / instructors" as it always has, and
 * over a week it reads instructor-days against the days that were possible.
 */
export function buildInstituteRows({
  colleges = [],
  roster = [],
  identificationSettings = {},
  enrolment = new Map(),
  groups = [],
  workingDays = 1,
}) {
  const totals = new Map(groups.map((row) => [row._id == null ? "" : String(row._id), row]));
  const rosterByCollege = new Map();
  for (const instructor of roster) {
    const key = instructor.college_id == null ? "" : String(instructor.college_id);
    rosterByCollege.set(key, (rosterByCollege.get(key) || 0) + 1);
  }
  const identification = new Map(
    describeCollegeIdentification(identificationSettings, colleges, enrolment)
      .map((row) => [row.college_id, row])
  );
  return colleges.map((row) => {
    const collegeId = String(row._id);
    const group = totals.get(collegeId) || {};
    const present = Number(group.check_ins) || 0;
    const compliant = Number(group.compliant) || 0;
    const nonCompliant = Number(group.non_compliant) || 0;
    const instructors = rosterByCollege.get(collegeId) || 0;
    const expected = instructors * workingDays;
    const described = identification.get(collegeId);
    return {
      college_id: collegeId,
      name: row.name || "Unnamed institute",
      mode: described?.mode || "FACE_ONLY",
      present,
      expected,
      instructors,
      present_percent: percent(present, expected),
      compliant,
      non_compliant: nonCompliant,
      compliance_percent: percent(compliant, compliant + nonCompliant),
      unidentified: Number(group.unidentified) || 0,
      enrolled: described?.enrolled ?? 0,
      enrolled_percent: described?.enrolled_percent ?? 0,
      low_enrolment: Boolean(described?.low_enrolment),
    };
  });
}

/**
 * Turns the loaded rows into the Dashboard response.
 *
 * `weekRecords` covers this Monday-to-today plus the previous working day, so
 * today's figures, the week's escalations and yesterday's missed check-outs
 * all come from one read. `trendRows` are per-day totals already grouped by the
 * database. `failedRows` are the FAIL checkpoint rows of this week's
 * evaluations, one per failed checkpoint.
 */
export function buildDashboard({
  now,
  timeZone,
  college = null,
  colleges = [],
  roster = [],
  identificationSettings = {},
  enrolment = new Map(),
  weekRecords = [],
  trendRows = [],
  unidentifiedByCollege = [],
  failedRows = [],
}) {
  const todayKey = localDateKey(now, timeZone);
  const weekStart = weekStartKey(todayKey);
  const previousDay = previousWorkingDayKey(todayKey);
  const sameDayLastWeek = addDaysToKey(todayKey, -7);

  const rosterById = new Map(roster.map((instructor) => [String(instructor._id), instructor]));
  const collegeNames = new Map(colleges.map((row) => [String(row._id), row.name || "Unnamed institute"]));

  const records = weekRecords.map((record) => ({ ...record, _day: dayKeyOf(record, timeZone) }));
  const today = records.filter((record) => record._day === todayKey);
  const todayIdentified = today.filter(identified);

  // ---- Today ---------------------------------------------------------------
  const presentIds = new Set(
    todayIdentified
      .map((record) => String(record.instructor_id))
      .filter((id) => rosterById.has(id))
  );
  const byStatus = { compliant: 0, unassessed: 0, non_compliant: 0, pending: 0, error: 0 };
  let oldestPending = null;
  let retakeRecommended = 0;
  let checkedOut = 0;
  for (const record of todayIdentified) {
    const status = dashboardStatus(record.status);
    if (status in byStatus) byStatus[status] += 1;
    if (status === "pending" && record.check_in_time) {
      const at = new Date(record.check_in_time).getTime();
      if (oldestPending === null || at < oldestPending) oldestPending = at;
    }
    if (record.image_quality === "RETAKE_RECOMMENDED" && (status === "compliant" || status === "non_compliant" || status === "unassessed")) {
      retakeRecommended += 1;
    }
    if (record.check_out_time) checkedOut += 1;
  }
  const analysed = byStatus.compliant + byStatus.non_compliant;
  const missedCheckout = records.filter(
    (record) => record._day === previousDay && identified(record) && !record.check_out_time
  ).length;

  // ---- Trend ---------------------------------------------------------------
  const trendByDay = new Map(trendRows.map((row) => [String(row._id), row]));
  const totalInstructors = roster.length;
  const trend = workingDayKeys(todayKey, TREND_WORKING_DAYS).map((day) => {
    const row = trendByDay.get(day) || {};
    const present = Number(row.present) || 0;
    const compliant = Number(row.compliant) || 0;
    const nonCompliant = Number(row.non_compliant) || 0;
    return {
      day,
      present,
      present_percent: percent(present, totalInstructors),
      compliant,
      non_compliant: nonCompliant,
      compliance_percent: percent(compliant, compliant + nonCompliant),
    };
  });
  const lastWeekRow = trendByDay.get(sameDayLastWeek);
  const lastWeekCompliance = lastWeekRow
    ? percent(Number(lastWeekRow.compliant) || 0, (Number(lastWeekRow.compliant) || 0) + (Number(lastWeekRow.non_compliant) || 0))
    : null;

  // ---- Failed checkpoints, this week ----------------------------------------
  const weekRecordsById = new Map(
    records.filter((record) => record._day >= weekStart).map((record) => [String(record._id), record])
  );
  const countedFailures = failedRows.filter((row) => {
    const record = weekRecordsById.get(String(row.attendance_id));
    if (!record) return false;
    // A check-out result counts only while the check-out it describes exists.
    if (row.kind === "checkout") return Boolean(record.check_out_time) && !record.checkout_deleting_at;
    return true;
  });
  const failureCounts = new Map();
  for (const row of countedFailures) {
    const current = failureCounts.get(row.code) || { code: row.code, name: row.name || row.code, count: 0 };
    current.count += 1;
    failureCounts.set(row.code, current);
  }
  const failedCheckpoints = [...failureCounts.values()]
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, FAILED_CHECKPOINT_LIMIT)
    .map((row) => ({ ...row, audience: checkpointAudience(row.code) }));

  // ---- Escalations, this week ------------------------------------------------
  const weekByInstructor = new Map();
  for (const record of weekRecordsById.values()) {
    if (!identified(record)) continue;
    const id = String(record.instructor_id);
    if (!weekByInstructor.has(id)) weekByInstructor.set(id, []);
    weekByInstructor.get(id).push(record);
  }
  const failuresByAttendance = new Map();
  for (const row of countedFailures) {
    const key = String(row.attendance_id);
    if (!failuresByAttendance.has(key)) failuresByAttendance.set(key, []);
    failuresByAttendance.get(key).push(row.name || row.code);
  }
  const escalations = [];
  for (const [instructorId, group] of weekByInstructor) {
    const count = nonCompliantOccurrences(group).length;
    if (count < ESCALATION_THRESHOLD) continue;
    const latest = group.reduce((a, b) => (new Date(a.check_in_time || 0) > new Date(b.check_in_time || 0) ? a : b));
    const instructor = rosterById.get(instructorId);
    const collegeId = latest.college_id || instructor?.college_id || null;
    escalations.push({
      instructor_id: instructorId,
      name: instructor?.name || latest.instructor_name || "Unknown instructor",
      college_name: collegeId ? (collegeNames.get(String(collegeId)) || "Unknown institute") : "No institute",
      count,
      top_checkpoint: mostFrequent(group.flatMap((record) => failuresByAttendance.get(String(record._id)) || [])),
      attendance_id: String(latest._id),
    });
  }
  escalations.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

  // ---- Women's attire, this week ----------------------------------------------
  // Men's evaluations are always recorded as FORMAL, so only women count here.
  const attire = { analysed: 0, saree: 0, kurti: 0, formal: 0 };
  for (const record of weekRecordsById.values()) {
    if (!identified(record)) continue;
    const gender = String(rosterById.get(String(record.instructor_id))?.gender || "").toUpperCase();
    if (gender !== "FEMALE" || !WOMENS_ATTIRE.includes(record.attire_type)) continue;
    attire.analysed += 1;
    if (record.attire_type === "SAREE") attire.saree += 1;
    else if (record.attire_type === "KURTI_WITH_DUPATTA") attire.kurti += 1;
    else attire.formal += 1;
  }

  // ---- Institutes, today -----------------------------------------------------
  // The whole unidentified queue, whatever day each arrival was on, is the
  // figure on the Unidentified tile. The table counts only the day it shows.
  const unidentifiedTotal = unidentifiedByCollege.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
  const institutes = buildInstituteRows({
    colleges,
    roster,
    identificationSettings,
    enrolment,
    groups: instituteGroupsFromRecords(today),
    workingDays: 1,
  });

  return {
    generated_at: now.toISOString(),
    time_zone: timeZone,
    today: todayKey,
    week_start: weekStart,
    previous_working_day: previousDay,
    same_day_last_week: sameDayLastWeek,
    college: college ? { college_id: String(college._id), name: college.name || "Unnamed institute" } : null,
    summary: {
      total_instructors: totalInstructors,
      present: presentIds.size,
      present_percent: percent(presentIds.size, totalInstructors),
      not_checked_in: Math.max(0, totalInstructors - presentIds.size),
      check_ins: todayIdentified.length,
      analysed,
      compliant: byStatus.compliant,
      non_compliant: byStatus.non_compliant,
      compliance_percent: percent(byStatus.compliant, analysed),
      compliance_same_day_last_week: lastWeekCompliance,
      unassessed: byStatus.unassessed,
      pending: byStatus.pending,
      oldest_pending_seconds: oldestPending === null
        ? null
        : Math.max(0, Math.round((now.getTime() - oldestPending) / 1000)),
      errors: byStatus.error,
      retake_recommended: retakeRecommended,
      checked_out: checkedOut,
      on_duty: Math.max(0, todayIdentified.length - checkedOut),
      missed_checkout_previous_day: missedCheckout,
      unidentified_waiting: unidentifiedTotal,
      unidentified_today: today.filter((record) => !identified(record) && dashboardStatus(record.status) === "unidentified").length,
    },
    status_breakdown: [
      { key: "compliant", count: byStatus.compliant },
      { key: "unassessed", count: byStatus.unassessed },
      { key: "non_compliant", count: byStatus.non_compliant },
      { key: "pending", count: byStatus.pending },
      { key: "error", count: byStatus.error },
    ],
    trend,
    arrivals: arrivalSlots(today, timeZone),
    failed_checkpoints: failedCheckpoints,
    escalations,
    attire,
    institutes,
  };
}
