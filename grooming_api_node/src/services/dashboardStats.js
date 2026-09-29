import {
  addDaysToKey,
} from "./evaluationWorker.js";
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
