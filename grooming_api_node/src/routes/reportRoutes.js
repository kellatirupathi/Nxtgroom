import crypto from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { asyncRoute } from "../utils.js";
import { idMatch } from "../middleware/auth.js";
import { appUrl, runtimeConfig } from "../config/env.js";
import {
  findInstructorByReportToken,
  isValidDateKey,
  localDateKey,
  summariseWeek,
  weekStartKey,
  workingWeekDates,
  ensureReportToken,
} from "../services/instructorReports.js";
import { getReportRecipients } from "../services/reportRecipients.js";
import { getPhotoUrl } from "../services/photoStorage.js";
import {
  sendAttendanceReminderEmail,
  sendWeeklyReportEmail,
} from "../services/emailService.js";

export const reportRouter = Router();

/**
 * Public report pages are unauthenticated by design — the recipient has no
 * FacultyTrack account — so the token in the URL is the only credential.
 * Rate limiting makes guessing one impractical rather than merely unlikely.
 */
const publicReportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { detail: "Too many requests. Please try again later." },
});

/**
 * Cron endpoints are triggered by cron-jobs.org, which cannot hold a session,
 * so they authenticate with a shared secret. Compared in constant time so the
 * comparison itself cannot leak the secret one byte at a time.
 */
function requireCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET || "";
  if (!expected) {
    return res.status(503).json({ detail: "CRON_SECRET is not configured on the server" });
  }
  const supplied = String(
    req.get("x-cron-secret") || req.query.secret || ""
  );
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  const matches = expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
  if (!matches) return res.status(401).json({ detail: "Invalid cron secret" });
  return next();
}

/** Month bounds for the monthly totals shown beneath the weekly table. */
function monthKeyOf(dateKey) {
  return dateKey.slice(0, 7);
}

async function loadInstructorWeek(db, instructor, startKey) {
  const dates = workingWeekDates(startKey);
  const from = new Date(`${dates[0]}T00:00:00.000Z`);
  // Widened by a day at each end so a check-in near midnight in Asia/Kolkata
  // is not excluded by the UTC comparison; summariseWeek re-buckets by local date.
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${dates[dates.length - 1]}T23:59:59.999Z`);
  to.setUTCDate(to.getUTCDate() + 1);

  const records = await db.collection("attendance")
    .find({
      instructor_id: String(instructor._id),
      check_in_time: { $gte: from, $lte: to },
    })
    .sort({ check_in_time: 1 })
    .toArray();

  const inWeek = records.filter((record) => (
    dates.includes(localDateKey(new Date(record.check_in_time || record.date)))
  ));
  return summariseWeek(inWeek, startKey, { gender: instructor.gender });
}

async function loadInstructorMonth(db, instructor, monthKey) {
  const from = new Date(`${monthKey}-01T00:00:00.000Z`);
  const to = new Date(from);
  to.setUTCMonth(to.getUTCMonth() + 1);
  const records = await db.collection("attendance")
    .find({ instructor_id: String(instructor._id), check_in_time: { $gte: from, $lt: to } })
    .toArray();

  const present = records.length;
  return {
    month: monthKey,
    present_days: present,
    compliant_days: records.filter((r) => r.status === "compliant").length,
    non_compliant_days: records.filter((r) => r.status === "non_compliant").length,
    saree_days: records.filter((r) => r.attire_type === "SAREE").length,
    kurti_days: records.filter((r) => r.attire_type === "KURTI_WITH_DUPATTA").length,
    formal_days: records.filter((r) => r.attire_type === "FORMAL").length,
    missed_checkouts: records.filter((r) => !r.check_out_time).length,
  };
}

/**
 * The report page's data. Returns one week plus that month's totals, and
 * nothing that would let the caller browse to another week: the page is a
 * fixed view of the period the email was about.
 */
reportRouter.get(
  "/:token/week/:weekStart",
  publicReportLimiter,
  asyncRoute(async (req, res) => {
    const { token, weekStart } = req.params;
    if (!isValidDateKey(weekStart)) {
      return res.status(400).json({ detail: "Invalid week" });
    }
    const db = req.app.locals.db;
    const instructor = await findInstructorByReportToken(db, token);
    // The same response for a bad token and an unknown one, so the endpoint
    // cannot be used to confirm a token exists.
    if (!instructor) return res.status(404).json({ detail: "Report not found" });

    const normalizedStart = weekStartKey(new Date(`${weekStart}T12:00:00Z`));
    const [week, month] = await Promise.all([
      loadInstructorWeek(db, instructor, normalizedStart),
      loadInstructorMonth(db, instructor, monthKeyOf(normalizedStart)),
    ]);

    return res.json({
      instructor: {
        name: instructor.name,
        role: instructor.instructor_role || instructor.role || null,
        institute: instructor.institute_name || null,
      },
      week,
      month,
    });
  })
);

/**
 * One day's check-in with its full checkpoint detail. This is what the
 * immediate alert email links to.
 */
reportRouter.get(
  "/:token/day/:date",
  publicReportLimiter,
  asyncRoute(async (req, res) => {
    const { token, date } = req.params;
    if (!isValidDateKey(date)) return res.status(400).json({ detail: "Invalid date" });

    const db = req.app.locals.db;
    const instructor = await findInstructorByReportToken(db, token);
    if (!instructor) return res.status(404).json({ detail: "Report not found" });

    const from = new Date(`${date}T00:00:00.000Z`);
    from.setUTCDate(from.getUTCDate() - 1);
    const to = new Date(`${date}T23:59:59.999Z`);
    to.setUTCDate(to.getUTCDate() + 1);
    const candidates = await db.collection("attendance")
      .find({ instructor_id: String(instructor._id), check_in_time: { $gte: from, $lte: to } })
      .sort({ check_in_time: 1 })
      .toArray();
    const record = candidates.find((item) => (
      localDateKey(new Date(item.check_in_time || item.date)) === date
    ));
    if (!record) return res.status(404).json({ detail: "No check-in was recorded that day" });

    const evaluation = await db.collection("evaluations").findOne({
      attendance_id: String(record._id),
    });
    // The saree/kurti rotation is a claim about the week, not about this
    // photograph, so it is counted from the week the day falls in. Null for
    // men, who have no rotation to satisfy.
    const { weekly_rotation: weeklyRotation } = await loadInstructorWeek(
      db,
      instructor,
      weekStartKey(new Date(`${date}T12:00:00.000Z`))
    );

    return res.json({
      instructor: {
        name: instructor.name,
        role: instructor.instructor_role || instructor.role || null,
        institute: instructor.institute_name || null,
      },
      date,
      attendance: {
        check_in_time: record.check_in_time,
        check_out_time: record.check_out_time,
        status: record.status,
        attire_type: record.attire_type || null,
        remarks: record.remarks || null,
        location_address: record.location_address || null,
        // Presence only. The key itself is withheld: it would let a recipient
        // construct requests for objects this endpoint never offered them.
        has_checkin_photo: Boolean(record.check_in_photo_key),
        has_checkout_photo: Boolean(record.check_out_photo_key),
      },
      // Null rather than 404 when analysis has not finished, so the page can
      // say so instead of looking like a broken link.
      weekly_rotation: weeklyRotation,
      evaluation: evaluation
        ? {
          overall_status: evaluation.overall_status,
          ai_summary: evaluation.ai_summary,
          image_quality: evaluation.image_quality,
          attire_type: evaluation.attire_type || record.attire_type || "UNKNOWN",
          // Explains the N/A rows: a checkpoint marked unassessable should be
          // traceable to a part of the body the photograph did not show.
          visible_regions: evaluation.visible_regions || null,
          unassessed_reason: evaluation.unassessed_reason || null,
          improvement_tips: evaluation.improvement_tips || [],
          general_idcard_check: evaluation.general_idcard_check || [],
          grooming_check: evaluation.grooming_check || [],
          attire_check: evaluation.attire_check || [],
          accessories_check: evaluation.accessories_check || [],
          footwear_check: evaluation.footwear_check || [],
        }
        : null,
    });
  })
);

/**
 * Sends the weekly summary to every instructor who has an address and at
 * least one check-in that week. Triggered by cron on Sunday morning.
 */
/**
 * A time-limited link to a photo from one day's check-in.
 *
 * Authenticated by the report token in the path, exactly as the page is: the
 * recipient has no account, and this must expose nothing the page they were
 * sent does not already cover. The date is required so a token cannot be used
 * to walk through every photo the instructor has.
 */
reportRouter.get(
  "/:token/day/:date/photo/:kind",
  publicReportLimiter,
  asyncRoute(async (req, res) => {
    const { token, date } = req.params;
    const kind = req.params.kind === "checkout" ? "checkout" : "checkin";
    if (!isValidDateKey(date)) return res.status(400).json({ detail: "Invalid date" });

    const db = req.app.locals.db;
    const instructor = await findInstructorByReportToken(db, token);
    if (!instructor) return res.status(404).json({ detail: "Report not found" });

    const from = new Date(`${date}T00:00:00.000Z`);
    from.setUTCDate(from.getUTCDate() - 1);
    const to = new Date(`${date}T23:59:59.999Z`);
    to.setUTCDate(to.getUTCDate() + 1);
    const candidates = await db.collection("attendance")
      .find({ instructor_id: String(instructor._id), check_in_time: { $gte: from, $lte: to } })
      .sort({ check_in_time: 1 })
      .toArray();
    const record = candidates.find((item) => (
      localDateKey(new Date(item.check_in_time || item.date)) === date
    ));
    if (!record) return res.status(404).json({ detail: "No check-in was recorded that day" });

    const key = kind === "checkout" ? record.check_out_photo_key : record.check_in_photo_key;
    if (!key) return res.status(404).json({ detail: "No photo was stored for this check-in" });

    const url = await getPhotoUrl(key, { expiresIn: 900 });
    if (!url) return res.status(503).json({ detail: "Photo storage is unavailable right now" });
    return res.json({ url, expires_in: 900 });
  })
);

/**
 * Delivers the weekly summaries. Runs detached from the request because a
 * scheduler times a call out — cron-jobs.org after 30 seconds — while sending
 * one email per instructor takes far longer than that at any real roster size.
 * A timed-out call would be recorded as a failure even though the send was
 * proceeding normally.
 */
async function deliverWeeklyReports(db, startKey) {
  const dates = workingWeekDates(startKey);
  const from = new Date(`${dates[0]}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${dates[dates.length - 1]}T23:59:59.999Z`);
  to.setUTCDate(to.getUTCDate() + 1);

  const instructorIds = await db.collection("attendance").distinct("instructor_id", {
    check_in_time: { $gte: from, $lte: to },
  });

  let sent = 0;
  let skipped = 0;
  const failures = [];
  for (const instructorId of instructorIds) {
    try {
      const instructor = await db.collection("instructors").findOne({ _id: idMatch(String(instructorId)) });
      if (!instructor?.email) {
        skipped += 1;
        continue;
      }
      const summary = await loadInstructorWeek(db, instructor, startKey);
      if (summary.present_days === 0) {
        skipped += 1;
        continue;
      }
      const reportToken = await ensureReportToken(db, instructor);
      const result = await sendWeeklyReportEmail(instructor.email, {
        name: instructor.name,
        summary,
        reportUrl: `${appUrl()}/reports/${reportToken}/week/${startKey}`,
      });
      if (result.sent) sent += 1;
      else failures.push({ email: instructor.email, reason: result.reason });
    } catch (error) {
      // One bad record must not abandon the rest of the roster.
      failures.push({ instructor: String(instructorId), reason: error?.name || "error" });
    }
  }

  await db.collection("app_settings").updateOne(
    { _id: "weekly_report_run" },
    {
      $set: {
        _id: "weekly_report_run",
        week_start: startKey,
        finished_at: new Date(),
        considered: instructorIds.length,
        sent,
        skipped,
        failures: failures.slice(0, 20),
      },
    },
    { upsert: true }
  );
  console.log(`Weekly reports for ${startKey}: ${sent} sent, ${skipped} skipped, ${failures.length} failed`);
  return { sent, skipped, failures };
}

reportRouter.post(
  "/cron/weekly-reports",
  requireCronSecret,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    // Sunday belongs to the week that just ended, so "now" resolves to the
    // week being reported on without any date arithmetic here.
    const startKey = weekStartKey(new Date());

    // Claim the run before answering, so a scheduler retry after a timeout
    // cannot start a second pass and send everyone two copies.
    const claim = await db.collection("app_settings").updateOne(
      { _id: "weekly_report_claim", week_start: { $ne: startKey } },
      { $set: { _id: "weekly_report_claim", week_start: startKey, claimed_at: new Date() } },
      { upsert: true }
    );
    const alreadyRun = !(claim.upsertedCount || claim.modifiedCount);
    if (alreadyRun && req.query.force !== "1") {
      return res.json({ week_start: startKey, status: "already_sent_this_week" });
    }

    void deliverWeeklyReports(db, startKey);
    return res.status(202).json({
      week_start: startKey,
      status: "started",
      note: "Delivery continues in the background; see the weekly_report_run record for the outcome.",
    });
  })
);

/**
 * Nudges anyone who checked in without checking out, or checked out with no
 * check-in recorded. Triggered by cron at 20:00 local time.
 */
/**
 * Sends the missed-check-out nudges. Detached for the same reason as the
 * weekly run: one email per open check-in outlives a scheduler timeout.
 */
async function deliverAttendanceReminders(db) {
  const timeZone = runtimeConfig().appTimeZone;
  const today = localDateKey(new Date(), timeZone);
  const from = new Date(`${today}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${today}T23:59:59.999Z`);
  to.setUTCDate(to.getUTCDate() + 1);

  const records = await db.collection("attendance")
    .find({ check_in_time: { $gte: from, $lte: to }, check_out_time: null })
    .toArray();
  const todays = records.filter((record) => (
    localDateKey(new Date(record.check_in_time || record.date), timeZone) === today
  ));

  let sent = 0;
  const failures = [];
  for (const record of todays) {
    try {
      // Guard against a repeat run sending the same nudge twice.
      if (record.checkout_reminder_sent_at) continue;
      const instructor = await db.collection("instructors").findOne({ _id: idMatch(String(record.instructor_id)) });
      const email = instructor?.email;
      if (!email) continue;

      const result = await sendAttendanceReminderEmail(email, {
        name: record.instructor_name || instructor?.name,
        kind: "checkout",
        dateLabel: today,
      });
      if (result.sent) {
        sent += 1;
        await db.collection("attendance").updateOne(
          { _id: record._id },
          { $set: { checkout_reminder_sent_at: new Date() } }
        );
      } else {
        failures.push({ email, reason: result.reason });
      }
    } catch (error) {
      failures.push({ attendance: String(record._id), reason: error?.name || "error" });
    }
  }

  await db.collection("app_settings").updateOne(
    { _id: "attendance_reminder_run" },
    { $set: { _id: "attendance_reminder_run", date: today, finished_at: new Date(), checked: todays.length, sent, failures: failures.slice(0, 20) } },
    { upsert: true }
  );
  console.log(`Attendance reminders for ${today}: ${sent} sent of ${todays.length} open check-ins`);
  return { sent, failures };
}

reportRouter.post(
  "/cron/attendance-reminders",
  requireCronSecret,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    void deliverAttendanceReminders(db);
    return res.status(202).json({
      date: localDateKey(new Date()),
      status: "started",
      note: "Delivery continues in the background; see the attendance_reminder_run record for the outcome.",
    });
  })
);

/** Lets an operator confirm the cron secret works without sending anything. */
reportRouter.get(
  "/cron/health",
  requireCronSecret,
  asyncRoute(async (req, res) => {
    const recipients = await getReportRecipients(req.app.locals.db);
    return res.json({
      ok: true,
      time_zone: runtimeConfig().appTimeZone,
      current_week_start: weekStartKey(new Date()),
      today: localDateKey(new Date()),
      rp_recipients: recipients.length,
    });
  })
);
