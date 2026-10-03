import crypto from "node:crypto";
import { appUrl, runtimeConfig } from "../config/env.js";
import { idMatch } from "../middleware/auth.js";
import { improvementTips } from "../checkpoints.js";
import { dateBoundsInTimeZone } from "../utils.js";
import { ensureReportToken, isValidDateKey, localDateKey } from "./instructorReports.js";
import { isValidRecipient, normaliseEmail } from "./reportRecipients.js";
import {
  addSettingListValue,
  getSetting,
  removeSettingListValue,
  saveSetting,
} from "../stores/settingsStore.js";
import { evaluationsForSessions } from "../stores/evaluationStore.js";
import { getDeliveryRun, saveDeliveryRun } from "../stores/deliveryRunStore.js";

/**
 * The daily report: one email a day per send time, listing everyone who
 * checked in or out since the previous send, with what they need to improve,
 * and a link to the day's full page (see "The full-day page" below).
 *
 * It goes to its own recipient list, not to the reporting partners, who are
 * already copied on every individual report. Each send covers the time since
 * the previous send that day - the first from midnight - so the 1:00 PM email
 * is the morning and the 6:30 PM email the afternoon, with nobody counted in
 * two emails for the same event.
 */

export const DAILY_REPORT_SETTINGS_ID = "daily_report";
export const MAX_DAILY_REPORT_TIMES = 8;
export const MAX_DAILY_REPORT_RECIPIENTS = 50;
/** How long a report's public page keeps opening. */
export const DAILY_REPORT_LINK_DAYS = 30;
/** Rows one report reads at most: several days of a large roster. */
const MAX_REPORT_ROWS = 5000;
/** One report is rendered once for all its recipients within this window. */
const REPORT_CACHE_MS = 60_000;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function toDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// -- Settings ---------------------------------------------------------------

export async function getDailyReportSettings(db) {
  const document = await getSetting(db, DAILY_REPORT_SETTINGS_ID);
  const times = Array.isArray(document?.times)
    ? document.times.filter((time) => typeof time === "string" && TIME_PATTERN.test(time))
    : [];
  return {
    enabled: document?.enabled === true,
    times: [...new Set(times)].sort(),
    emails: (Array.isArray(document?.emails) ? document.emails : []).filter(isValidRecipient),
    schedule_changed_at: toDate(document?.schedule_changed_at),
  };
}

/** What the settings screen is shown and sends back. */
export function dailyReportSettingsView(settings) {
  return { enabled: settings.enabled, times: settings.times, emails: settings.emails };
}

/**
 * Validates a list of send times: 24-hour "HH:MM", no repeats, at most
 * MAX_DAILY_REPORT_TIMES. Returned sorted, which is the order they are sent.
 */
export function normaliseTimes(values) {
  if (!Array.isArray(values)) return { ok: false, detail: "times must be a list of HH:MM times." };
  if (values.length > MAX_DAILY_REPORT_TIMES) {
    return { ok: false, detail: `At most ${MAX_DAILY_REPORT_TIMES} send times can be set.` };
  }
  const times = [];
  for (const value of values) {
    if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
      return { ok: false, detail: "Each send time must be a valid time." };
    }
    if (times.includes(value)) return { ok: false, detail: `${slotLabel(value)} is listed twice.` };
    times.push(value);
  }
  return { ok: true, times: times.sort() };
}

/**
 * Saves the switch and the send times.
 *
 * schedule_changed_at moves only when either of them changes. A send time
 * that is already past when it is saved starts the next day rather than
 * firing at once: somebody adding "9:00 AM" at noon did not ask for a
 * report this minute.
 */
export async function saveDailyReportSchedule(db, body, updatedBy) {
  const current = await getDailyReportSettings(db);
  let { enabled, times } = current;
  if (body && "enabled" in body) {
    if (typeof body.enabled !== "boolean") return { ok: false, detail: "enabled must be true or false." };
    enabled = body.enabled;
  }
  if (body && "times" in body) {
    const result = normaliseTimes(body.times);
    if (!result.ok) return result;
    times = result.times;
  }
  const changed = enabled !== current.enabled || times.join(",") !== current.times.join(",");
  const now = new Date();
  await saveSetting(db, DAILY_REPORT_SETTINGS_ID, {
    set: {
      enabled,
      times,
      updated_at: now,
      updated_by: updatedBy || null,
      ...(changed ? { schedule_changed_at: now } : {}),
    },
    setOnInsert: { _id: DAILY_REPORT_SETTINGS_ID, created_at: now },
  });
  return { ok: true, settings: dailyReportSettingsView(await getDailyReportSettings(db)) };
}

export async function addDailyReportRecipient(db, value, addedBy) {
  const email = normaliseEmail(value);
  if (!isValidRecipient(email)) return { ok: false, reason: "invalid" };
  const { emails } = await getDailyReportSettings(db);
  if (emails.includes(email)) return { ok: false, reason: "duplicate" };
  if (emails.length >= MAX_DAILY_REPORT_RECIPIENTS) return { ok: false, reason: "limit" };
  const now = new Date();
  await addSettingListValue(db, DAILY_REPORT_SETTINGS_ID, "emails", email, {
    set: { updated_at: now, updated_by: addedBy || null },
    setOnInsert: { _id: DAILY_REPORT_SETTINGS_ID, created_at: now },
  });
  return { ok: true, emails: (await getDailyReportSettings(db)).emails };
}

export async function removeDailyReportRecipient(db, value, removedBy) {
  const email = normaliseEmail(value);
  if (!email) return { ok: false, reason: "invalid" };
  await removeSettingListValue(db, DAILY_REPORT_SETTINGS_ID, "emails", email, {
    set: { updated_at: new Date(), updated_by: removedBy || null },
  });
  return { ok: true, emails: (await getDailyReportSettings(db)).emails };
}

// -- Times and dates --------------------------------------------------------

/** "13:00" as "1:00 PM". */
export function slotLabel(slot) {
  const [hour, minute] = String(slot).split(":").map(Number);
  const period = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${period}`;
}

/** "2026-09-30" as the link segment "30-09-2026". */
export function dateSegment(dateKey) {
  const [year, month, day] = String(dateKey).split("-");
  return `${day}-${month}-${year}`;
}

/** "30-09-2026" back to "2026-09-30", or null. */
export function parseDateSegment(segment) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(segment || ""));
  if (!match) return null;
  const key = `${match[3]}-${match[2]}-${match[1]}`;
  return isValidDateKey(key) ? key : null;
}

/** "2026-09-30" as "30/09/2026", the date in the subject line. */
export function displayDate(dateKey) {
  return dateSegment(dateKey).replaceAll("-", "/");
}

export function dailyReportSubject(dateKey) {
  return `Daily report_Attendance & Grooming_Check_${displayDate(dateKey)}`;
}

/**
 * The moment a send time falls on a local date. Minutes are added to local
 * midnight, which is exact in a zone without daylight saving - Asia/Kolkata
 * has none.
 */
export function slotInstant(dateKey, slot, timeZone = runtimeConfig().appTimeZone) {
  const { start } = dateBoundsInTimeZone(dateKey, timeZone);
  const [hour, minute] = slot.split(":").map(Number);
  return new Date(start.getTime() + (hour * 60 + minute) * 60_000);
}

export function dailyReportRunId(dateKey, slot) {
  return `daily-report:${dateKey}:${slot}`;
}

/**
 * Today's reports whose send time has come, oldest first, each with the
 * period it covers.
 *
 * A send time counts today only if it is at or after the last schedule
 * change, so turning the report on - or adding a time - never sends for a
 * time that has already passed. The period starts at the previous send time
 * that counts today, or at midnight for the first, which keeps the morning in
 * the first report even when an earlier time was added late.
 */
export function dueDailyReports(settings, now = new Date(), timeZone = runtimeConfig().appTimeZone) {
  if (!settings?.enabled || !settings.times?.length) return [];
  const dateKey = localDateKey(now, timeZone);
  const dayStart = dateBoundsInTimeZone(dateKey, timeZone).start;
  const changedAt = toDate(settings.schedule_changed_at)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const due = [];
  let previous = dayStart;
  for (const slot of [...settings.times].sort()) {
    const at = slotInstant(dateKey, slot, timeZone);
    if (at.getTime() < changedAt) continue;
    if (at.getTime() > now.getTime()) break;
    due.push({ dateKey, slot, from: previous, to: at });
    previous = at;
  }
  return due;
}

// -- The full-day page ------------------------------------------------------

/**
 * Each day has one public page, opened by "See all reports" in every daily
 * report email sent that day. It covers the whole day, 12:00 AM to midnight,
 * and shows it as it stands when opened: the evening's check-outs appear on
 * the same link the 1:00 PM email carried.
 *
 * The page has no sign-in - recipients have no account - so the secret in the
 * link is the only credential. It is kept in a document of its own per date,
 * created once and read back, so every email and every administrator opening
 * that day gets the same link.
 */

/** A fresh random UUID: the secret part of a day's link. */
export function newLinkToken() {
  return crypto.randomUUID();
}

export function dailyReportDayId(dateKey) {
  return `daily-report-day:${dateKey}`;
}

export function dailyReportDayPath(dateKey, token) {
  return `/daily-report/${dateSegment(dateKey)}/${token}`;
}

export function dailyReportDayUrl(day) {
  return `${appUrl()}${dailyReportDayPath(day.date, day.link_token)}`;
}

function isDuplicateKey(error) {
  return error?.code === 11000;
}

/**
 * The day's page, created if this is the first time it is asked for. It
 * stays open for DAILY_REPORT_LINK_DAYS after the day ends - or after it was
 * created, for a past day opened later from the settings screen.
 */
export async function ensureDailyReportDay(db, dateKey, now = new Date()) {
  const id = dailyReportDayId(dateKey);
  const existing = await getDeliveryRun(db, id);
  const currentExpiry = toDate(existing?.expires_at);
  if (existing?.link_token && currentExpiry && currentExpiry.getTime() > now.getTime()) return existing;
  const dayEnd = dateBoundsInTimeZone(dateKey, runtimeConfig().appTimeZone).end;
  const expiresAt = new Date(
    Math.max(dayEnd.getTime(), now.getTime()) + DAILY_REPORT_LINK_DAYS * 24 * 60 * 60 * 1000
  );
  if (existing?.link_token) {
    // Expired: a new secret rather than a longer life for the old one, so a
    // link that has already stopped working stays stopped.
    await saveDeliveryRun(db, id, { set: { link_token: newLinkToken(), expires_at: expiresAt, updated_at: now } });
  } else {
    try {
      await saveDeliveryRun(db, id, {
        set: { updated_at: now },
        setOnInsert: {
          _id: id,
          type: "daily_report_day",
          date: dateKey,
          link_token: newLinkToken(),
          expires_at: expiresAt,
          created_at: now,
        },
      });
    } catch (error) {
      // Two servers asked for the same day in the same instant.
      if (!isDuplicateKey(error)) throw error;
    }
  }
  const day = await getDeliveryRun(db, id);
  if (!day?.link_token) throw new Error(`Daily report page for ${dateKey} could not be read back`);
  return day;
}

function sameSecret(expected, given) {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(given));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * The day a public link names, or null when the link is malformed, unknown,
 * does not carry that day's secret, or has expired.
 */
export async function findDailyReportDay(db, dateValue, token, now = new Date()) {
  const dateKey = parseDateSegment(dateValue);
  if (!dateKey || typeof token !== "string" || !LINK_TOKEN_PATTERN.test(token)) return null;
  const day = await getDeliveryRun(db, dailyReportDayId(dateKey));
  if (!day || day.type !== "daily_report_day" || typeof day.link_token !== "string") return null;
  if (!sameSecret(day.link_token, token)) return null;
  const expiresAt = toDate(day.expires_at);
  if (!expiresAt || expiresAt.getTime() <= now.getTime()) return null;
  return day;
}

// -- The report -------------------------------------------------------------

function clockTime(value, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(value);
}

/** 09:11 AM, with the day in front when it is not the report's day. */
function eventTime(value, reportDate, timeZone) {
  const time = clockTime(value, timeZone);
  const day = localDateKey(value, timeZone);
  return day === reportDate ? time : `${dateSegment(day).slice(0, 5).replace("-", "/")} ${time}`;
}

const STATE_TEXT = {
  compliant: "No improvements needed",
  unassessed: "Not assessed: the photo did not show enough",
  error: "Analysis failed: open the report",
  pending: "Analysis in progress",
};

/**
 * One half's outcome. The stored evaluation is the source of truth; without
 * one, the verdict on the attendance record says whether the analysis failed,
 * finished before evaluations were kept separately, or is still running.
 */
function halfOutcome(record, kind, evaluation) {
  if (evaluation) {
    const overall = String(evaluation.overall_status || "").toUpperCase();
    if (overall === "NON_COMPLIANT") {
      const tips = Array.isArray(evaluation.improvement_tips)
        ? evaluation.improvement_tips
        : improvementTips(evaluation);
      return { state: "non_compliant", tips: tips.filter((tip) => typeof tip === "string" && tip.trim()) };
    }
    if (overall === "COMPLIANT") return { state: "compliant", tips: [] };
    if (overall === "UNASSESSED") return { state: "unassessed", tips: [] };
  }
  const status = String(
    (kind === "checkout" ? record.checkout_compliance_status : record.status) || ""
  ).toLowerCase();
  if (["non_compliant", "non-compliant", "fail"].includes(status)) return { state: "non_compliant", tips: [] };
  if (["compliant", "done", "review_required", "needs_review"].includes(status)) return { state: "compliant", tips: [] };
  if (status === "unassessed") return { state: "unassessed", tips: [] };
  if (["error", "analysis_error"].includes(status)) return { state: "error", tips: [] };
  return { state: "pending", tips: [] };
}

function outcomeText(outcome) {
  if (outcome.state !== "non_compliant") return STATE_TEXT[outcome.state];
  return outcome.tips.length ? outcome.tips.join(" ") : "Did not meet the standards: open the report";
}

/** The two verdicts the email reports, as they read in its Status column. */
export const DAILY_STATUS_LABELS = Object.freeze({
  compliant: "Compliant",
  non_compliant: "Non-compliant",
});

function reportLink(token, dayKey, kind) {
  if (!token) return null;
  return `${appUrl()}/reports/${token}/day/${dayKey}/${kind === "checkout" ? "check-out" : "check-in"}`;
}

/**
 * The rows of one report: everyone who checked in or checked out within the
 * run's period, with the check-out shown only if it happened before the
 * period ended, so a later look at the page shows the same people and times
 * the email did. Improvement points follow the analysis, which may finish
 * after the email was sent.
 *
 * ensureTokens gives an instructor without a report link one; the email does
 * that, the public page only reads.
 */
export async function buildDailyReport(db, run, { ensureTokens = false } = {}) {
  const timeZone = runtimeConfig().appTimeZone;
  const from = toDate(run.window_from);
  const to = toDate(run.window_to);
  if (!from || !to) throw new Error("Daily report run has no period");
  const dayStart = dateBoundsInTimeZone(run.date, timeZone).start;

  const records = await db.collection("attendance")
    .find(
      {
        // Bounded on the indexed check-in instant: a check-out in the period
        // closes a session that started this day or, past midnight, the day
        // before.
        date: { $gte: new Date(dayStart.getTime() - 24 * 60 * 60 * 1000), $lt: to },
        deleting_at: { $exists: false },
        instructor_id: { $nin: [null, ""] },
        status: { $ne: "unidentified" },
        $or: [
          { check_in_time: { $gte: from, $lt: to } },
          { check_out_time: { $gte: from, $lt: to } },
        ],
      },
      {
        projection: {
          instructor_id: 1,
          instructor_name: 1,
          college_id: 1,
          attendance_day: 1,
          check_in_time: 1,
          check_out_time: 1,
          checkout_deleting_at: 1,
          status: 1,
          checkout_compliance_status: 1,
        },
      }
    )
    .sort({ check_in_time: 1 })
    .limit(MAX_REPORT_ROWS)
    .toArray();

  const instructorIds = [...new Set(records.map((record) => String(record.instructor_id)))];
  const instructors = instructorIds.length
    ? await db.collection("instructors")
      .find(
        { _id: { $in: instructorIds.flatMap((id) => idMatch(id).$in) } },
        { projection: { name: 1, report_token: 1, college_id: 1 } }
      )
      .toArray()
    : [];
  const instructorById = new Map(instructors.map((instructor) => [String(instructor._id), instructor]));
  // The institute the check-in was made at, or else the instructor's own.
  const collegeOf = (record) => record.college_id || instructorById.get(String(record.instructor_id))?.college_id || null;
  const collegeIds = [...new Set(records.map(collegeOf).filter(Boolean).map(String))];
  const colleges = collegeIds.length
    ? await db.collection("colleges")
      .find({ _id: { $in: collegeIds.flatMap((id) => idMatch(id).$in) } }, { projection: { name: 1 } })
      .toArray()
    : [];
  const collegeName = new Map(colleges.map((college) => [String(college._id), college.name]));
  if (ensureTokens) {
    for (const instructor of instructors) {
      if (!instructor.report_token) instructor.report_token = await ensureReportToken(db, instructor);
    }
  }

  const evaluations = await evaluationsForSessions(db, records.map((record) => String(record._id)));
  const evaluationFor = new Map(evaluations.map((evaluation) => [
    `${String(evaluation.attendance_id)}|${evaluation.kind === "checkout" ? "checkout" : "checkin"}`,
    evaluation,
  ]));

  const rows = [];
  for (const record of records) {
    const checkIn = toDate(record.check_in_time);
    if (!checkIn) continue;
    const rawCheckOut = record.checkout_deleting_at ? null : toDate(record.check_out_time);
    const checkOut = rawCheckOut && rawCheckOut.getTime() < to.getTime() ? rawCheckOut : null;
    const halves = [];
    if (checkIn.getTime() >= from.getTime() && checkIn.getTime() < to.getTime()) halves.push("checkin");
    if (checkOut && checkOut.getTime() >= from.getTime()) halves.push("checkout");
    if (!halves.length) continue;

    // Status and feedback are the check-in's, whichever half brought the
    // person into this period: a later email lists who checked out since,
    // still judged on how they arrived.
    const arrival = halfOutcome(record, "checkin", evaluationFor.get(`${String(record._id)}|checkin`));
    // Only a finished verdict is reported. A check-in still being analysed,
    // one whose photo could not be assessed, and a failed analysis are left
    // out; the full-day page still lists everyone.
    if (!DAILY_STATUS_LABELS[arrival.state]) continue;
    const instructor = instructorById.get(String(record.instructor_id));
    const sessionDay = record.attendance_day || localDateKey(checkIn, timeZone);
    const college = collegeOf(record);
    rows.push({
      name: record.instructor_name || instructor?.name || "Instructor",
      institute: (college && collegeName.get(String(college))) || "",
      checkIn: eventTime(checkIn, run.date, timeZone),
      checkOut: checkOut ? eventTime(checkOut, run.date, timeZone) : "-",
      status: arrival.state,
      points: [outcomeText(arrival)],
      // The check-in's report, which the status and feedback come from.
      reportUrl: reportLink(instructor?.report_token, sessionDay, "checkin"),
      // Non-compliant first.
      severity: arrival.state === "non_compliant" ? 0 : 1,
      sortTime: checkIn.getTime(),
    });
  }
  rows.sort((left, right) => left.severity - right.severity || left.sortTime - right.sortTime);

  return {
    date: run.date,
    slot: run.slot,
    dateLabel: displayDate(run.date),
    windowLabel: `${clockTime(from, timeZone)} to ${clockTime(to, timeZone)}`,
    subject: dailyReportSubject(run.date),
    rows: rows.map(({ sortTime, ...row }) => row),
  };
}

/**
 * The full-day page: every session that started on this date, 12:00 AM to
 * midnight - check-in and check-out times, the check-in's feedback, which
 * photographs exist, and a link to each report. In check-in order, as the
 * day happened.
 *
 * ensureTokens gives an instructor without a report link one, so every row
 * can link to its reports.
 */
export async function buildFullDayReport(db, dateKey, { ensureTokens = false } = {}) {
  const timeZone = runtimeConfig().appTimeZone;
  const { start, end } = dateBoundsInTimeZone(dateKey, timeZone);
  const records = await db.collection("attendance")
    .find(
      {
        date: { $gte: start, $lt: end },
        check_in_time: { $gte: start, $lt: end },
        deleting_at: { $exists: false },
        instructor_id: { $nin: [null, ""] },
        status: { $ne: "unidentified" },
      },
      {
        projection: {
          instructor_id: 1,
          instructor_name: 1,
          college_id: 1,
          attendance_day: 1,
          check_in_time: 1,
          check_out_time: 1,
          checkout_deleting_at: 1,
          status: 1,
          checkout_compliance_status: 1,
          check_in_photo_key: 1,
          check_out_photo_key: 1,
        },
      }
    )
    .sort({ check_in_time: 1 })
    .limit(MAX_REPORT_ROWS)
    .toArray();

  const instructorIds = [...new Set(records.map((record) => String(record.instructor_id)))];
  const instructors = instructorIds.length
    ? await db.collection("instructors")
      .find(
        { _id: { $in: instructorIds.flatMap((id) => idMatch(id).$in) } },
        { projection: { name: 1, report_token: 1, college_id: 1 } }
      )
      .toArray()
    : [];
  const instructorById = new Map(instructors.map((instructor) => [String(instructor._id), instructor]));
  const collegeOf = (record) => record.college_id || instructorById.get(String(record.instructor_id))?.college_id || null;
  const collegeIds = [...new Set(records.map(collegeOf).filter(Boolean).map(String))];
  const colleges = collegeIds.length
    ? await db.collection("colleges")
      .find({ _id: { $in: collegeIds.flatMap((id) => idMatch(id).$in) } }, { projection: { name: 1 } })
      .toArray()
    : [];
  const collegeName = new Map(colleges.map((college) => [String(college._id), college.name]));
  if (ensureTokens) {
    for (const instructor of instructors) {
      if (!instructor.report_token) instructor.report_token = await ensureReportToken(db, instructor);
    }
  }

  const evaluations = await evaluationsForSessions(db, records.map((record) => String(record._id)));
  const evaluationFor = new Map(evaluations.map((evaluation) => [
    `${String(evaluation.attendance_id)}|${evaluation.kind === "checkout" ? "checkout" : "checkin"}`,
    evaluation,
  ]));

  const rows = [];
  for (const record of records) {
    const checkIn = toDate(record.check_in_time);
    if (!checkIn) continue;
    const checkOut = record.checkout_deleting_at ? null : toDate(record.check_out_time);
    const id = String(record._id);
    const token = instructorById.get(String(record.instructor_id))?.report_token;
    const sessionDay = record.attendance_day || dateKey;
    // The check-in's feedback: the day's appearance is judged on arrival.
    const checkinOutcome = halfOutcome(record, "checkin", evaluationFor.get(`${id}|checkin`));
    const feedback = outcomeText(checkinOutcome);
    const college = collegeOf(record);
    rows.push({
      attendanceId: id,
      date: displayDate(dateKey),
      name: record.instructor_name || instructorById.get(String(record.instructor_id))?.name || "Instructor",
      institute: (college && collegeName.get(String(college))) || "",
      // The check-in's result, which the page filters on:
      // compliant | non_compliant | pending | unassessed | error.
      status: checkinOutcome.state,
      checkIn: clockTime(checkIn, timeZone),
      checkOut: checkOut ? eventTime(checkOut, dateKey, timeZone) : "-",
      feedback,
      hasCheckinPhoto: Boolean(record.check_in_photo_key),
      hasCheckoutPhoto: Boolean(checkOut && record.check_out_photo_key),
      checkinReportUrl: reportLink(token, sessionDay, "checkin"),
      checkoutReportUrl: checkOut ? reportLink(token, sessionDay, "checkout") : null,
    });
  }

  return {
    date: dateKey,
    dateLabel: displayDate(dateKey),
    windowLabel: "12:00 AM to 11:59 PM",
    subject: dailyReportSubject(dateKey),
    rows,
  };
}

/**
 * The stored photograph of one half of one session on the page's day, or
 * null. Only sessions the page lists can be asked for: the day's link opens
 * that day's photographs and nothing else.
 */
export async function dailyReportPhotoKey(db, dateKey, attendanceId, kind) {
  if (typeof attendanceId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(attendanceId)) return null;
  const { start, end } = dateBoundsInTimeZone(dateKey, runtimeConfig().appTimeZone);
  const record = await db.collection("attendance").findOne(
    {
      _id: idMatch(attendanceId),
      check_in_time: { $gte: start, $lt: end },
      deleting_at: { $exists: false },
      instructor_id: { $nin: [null, ""] },
      status: { $ne: "unidentified" },
    },
    { projection: { check_in_photo_key: 1, check_out_photo_key: 1, checkout_deleting_at: 1 } }
  );
  if (!record) return null;
  if (kind === "checkout") return record.checkout_deleting_at ? null : record.check_out_photo_key || null;
  return record.check_in_photo_key || null;
}

// -- The Reports tab ---------------------------------------------------------

/**
 * Check-ins and check-outs per local day, counted by the database. The same
 * sessions the full-day page lists: identified, not deleted, grouped by the
 * day they checked in, with a check-out counted once it exists and is not
 * being removed.
 */
export function dayCountsPipeline(start, end, timeZone = runtimeConfig().appTimeZone) {
  return [
    {
      $match: {
        date: { $gte: start, $lt: end },
        check_in_time: { $gte: start, $lt: end },
        deleting_at: { $exists: false },
        instructor_id: { $nin: [null, ""] },
        status: { $ne: "unidentified" },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$check_in_time", timezone: timeZone } },
        checkins: { $sum: 1 },
        checkouts: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gt: ["$check_out_time", null] },
                  { $not: [{ $gt: ["$checkout_deleting_at", null] }] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ];
}

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Links already made this process, so a refreshing Reports tab reads nothing. */
const dayLinkCache = new Map();
const DAY_LINK_CACHE_MS = 10 * 60 * 1000;

async function dayLinkFor(db, dateKey, now) {
  const cached = dayLinkCache.get(dateKey);
  if (cached && now.getTime() - cached.at < DAY_LINK_CACHE_MS && toDate(cached.day.expires_at) > now) {
    return cached.day;
  }
  const day = await ensureDailyReportDay(db, dateKey, now);
  dayLinkCache.set(dateKey, { at: now.getTime(), day });
  return day;
}

/**
 * The Reports tab for one month: every day up to today, newest first, with
 * its check-ins, check-outs, those checked in but not yet out, and the link
 * to the day's full report. A day nobody checked in has no report.
 */
export async function dailyReportDays(db, month, now = new Date()) {
  const timeZone = runtimeConfig().appTimeZone;
  if (!MONTH_PATTERN.test(String(month))) throw new RangeError("month must be YYYY-MM");
  const today = localDateKey(now, timeZone);
  const [year, monthNumber] = month.split("-").map(Number);
  const lastOfMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const firstKey = `${month}-01`;
  if (firstKey > today) return [];
  const monthEndKey = `${month}-${String(lastOfMonth).padStart(2, "0")}`;
  const lastKey = monthEndKey < today ? monthEndKey : today;
  const start = dateBoundsInTimeZone(firstKey, timeZone).start;
  const end = dateBoundsInTimeZone(lastKey, timeZone).end;

  const counts = await db.collection("attendance").aggregate(dayCountsPipeline(start, end, timeZone)).toArray();
  const byDay = new Map(counts.map((row) => [row._id, row]));

  const days = [];
  for (let day = Number(lastKey.slice(8)); day >= 1; day -= 1) {
    const dateKey = `${month}-${String(day).padStart(2, "0")}`;
    const checkins = Number(byDay.get(dateKey)?.checkins || 0);
    const checkouts = Math.min(checkins, Number(byDay.get(dateKey)?.checkouts || 0));
    days.push({
      date: dateKey,
      date_label: displayDate(dateKey),
      checkins,
      checkouts,
      not_checked_out: checkins - checkouts,
      report_url: checkins ? dailyReportDayUrl(await dayLinkFor(db, dateKey, now)) : null,
    });
  }
  return days;
}

const reportCache = new Map();

/**
 * The same report for every recipient of one run. Recipients are emailed
 * seconds apart, and an analysis finishing between two of them would
 * otherwise give two partners two different tables for the same report.
 */
export async function buildDailyReportForEmail(db, run, now = Date.now()) {
  for (const [key, entry] of reportCache) {
    if (now - entry.at > REPORT_CACHE_MS) reportCache.delete(key);
  }
  const cached = reportCache.get(run._id);
  if (cached) return cached.report;
  const report = await buildDailyReport(db, run, { ensureTokens: true });
  reportCache.set(run._id, { at: now, report });
  return report;
}
