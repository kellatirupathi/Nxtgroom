import crypto from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { asyncRoute, dateBoundsInTimeZone } from "../utils.js";
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
import { deletePhoto } from "../services/photoStorage.js";

/** Attendance photographs are kept for this long, then deleted. */
const PHOTO_RETENTION_MONTHS = 2;
/** Capped so one run cannot exceed the scheduler's request timeout. */
const PHOTO_PURGE_BATCH = 200;
import { evaluationFilter } from "../services/evaluationWorker.js";
import { getPhotoUrl } from "../services/photoStorage.js";
import { enqueueMailJob } from "../services/mailWorker.js";
import {
  getNotificationSettings,
  shouldSendWeeklyReport,
} from "../services/notificationSettings.js";

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
  const supplied = String(req.get("x-cron-secret") || "");
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
  const [year, month] = monthKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  const nextKey = next.toISOString().slice(0, 7);
  const zone = runtimeConfig().appTimeZone;
  const from = dateBoundsInTimeZone(`${monthKey}-01`, zone).start;
  const to = dateBoundsInTimeZone(`${nextKey}-01`, zone).start;
  const records = await db.collection("attendance")
    .find({ instructor_id: String(instructor._id), check_in_time: { $gte: from, $lt: to } })
    .sort({ check_in_time: 1 })
    .toArray();

  const uniqueDays = new Map();
  for (const record of records) {
    const key = localDateKey(new Date(record.check_in_time || record.date), zone);
    if (key.startsWith(`${monthKey}-`) && !uniqueDays.has(key)) uniqueDays.set(key, record);
  }
  const counted = [...uniqueDays.values()];
  return {
    month: monthKey,
    present_days: counted.length,
    compliant_days: counted.filter((r) => r.status === "compliant").length,
    non_compliant_days: counted.filter((r) => r.status === "non_compliant").length,
    saree_days: counted.filter((r) => r.attire_type === "SAREE").length,
    kurti_days: counted.filter((r) => r.attire_type === "KURTI_WITH_DUPATTA").length,
    formal_days: counted.filter((r) => r.attire_type === "FORMAL").length,
    missed_checkouts: counted.filter((r) => !r.check_out_time).length,
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
  ["/:token/day/:date", "/:token/day/:date/:half(check-in|check-out)"],
  publicReportLimiter,
  asyncRoute(async (req, res) => {
    const { token, date } = req.params;
    if (!isValidDateKey(date)) return res.status(400).json({ detail: "Invalid date" });
    // Both halves are assessed separately, so the link names which one it is
    // for. A bare /day/:date stays the check-in, which is what every link
    // already sent out points at.
    const half = req.params.half === "check-out" ? "checkout" : "checkin";

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

    const evaluation = await db.collection("evaluations").findOne(
      evaluationFilter(String(record._id), half)
    );
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
        // The verdict and summary belong to the half being shown. These fields
        // hold the check-in's, so a check-out report was displaying the
        // morning's status and the morning's remarks under a check-out
        // heading — the two reports read identically whatever the photographs
        // showed.
        status: half === "checkout"
          ? (record.checkout_compliance_status
            ? String(record.checkout_compliance_status).toLowerCase()
            : null)
          : record.status,
        attire_type: half === "checkout" ? null : (record.attire_type || null),
        remarks: half === "checkout"
          ? (record.checkout_remarks || null)
          : (record.remarks || null),
        location_address: half === "checkout"
          ? (record.check_out_location_address || null)
          : (record.location_address || null),
        // Presence only. The key itself is withheld: it would let a recipient
        // construct requests for objects this endpoint never offered them.
        has_checkin_photo: Boolean(record.check_in_photo_key),
        has_checkout_photo: Boolean(record.check_out_photo_key),
      },
      // Null rather than 404 when analysis has not finished, so the page can
      // say so instead of looking like a broken link.
      half,
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
  const notificationSettings = await getNotificationSettings(db);
  if (!shouldSendWeeklyReport(notificationSettings)) {
    console.log(`Weekly reports for ${startKey}: disabled by notification settings`);
    return { queued: 0, skipped: 0, failures: [], disabled: true };
  }

  const dates = workingWeekDates(startKey);
  const from = new Date(`${dates[0]}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${dates[dates.length - 1]}T23:59:59.999Z`);
  to.setUTCDate(to.getUTCDate() + 1);

  const instructorIds = await db.collection("attendance").distinct("instructor_id", {
    check_in_time: { $gte: from, $lte: to },
  });

  const runId = `weekly:${startKey}`;
  let queued = 0;
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
      await enqueueMailJob(db, {
        id: `${runId}:${String(instructor._id)}`,
        type: "weekly_report",
        toEmail: instructor.email,
        runId,
        payload: {
          name: instructor.name,
          summary,
          reportUrl: `${appUrl()}/reports/${reportToken}/week/${startKey}`,
        },
      });
      queued += 1;
    } catch (error) {
      // One bad record must not abandon the rest of the roster.
      failures.push({ instructor: String(instructorId), reason: error?.name || "error" });
    }
  }

  await db.collection("report_delivery_runs").updateOne(
    { _id: runId },
    {
      $set: {
        type: "weekly_report",
        week_start: startKey,
        production_finished_at: new Date(),
        considered: instructorIds.length,
        queued,
        skipped,
        producer_failures: failures.slice(0, 20),
        status: queued ? "queued" : "completed",
        updated_at: new Date(),
      },
      $setOnInsert: { sent: 0, failed: 0, terminal: 0, created_at: new Date() },
    },
    { upsert: true }
  );
  await db.collection("report_delivery_runs").updateOne(
    { _id: runId, $expr: { $gte: ["$terminal", "$queued"] } },
    { $set: { status: "completed", finished_at: new Date(), updated_at: new Date() } }
  );
  console.log(`Weekly reports for ${startKey}: ${queued} queued, ${skipped} skipped, ${failures.length} producer failures`);
  return { queued, skipped, failures };
}

reportRouter.post(
  "/cron/weekly-reports",
  requireCronSecret,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    // Sunday belongs to the week that just ended, so "now" resolves to the
    // week being reported on without any date arithmetic here.
    const startKey = weekStartKey(new Date());

    const result = await deliverWeeklyReports(db, startKey);
    return res.status(202).json({
      week_start: startKey,
      ...result,
      status: result.disabled ? "disabled" : "queued",
      note: result.disabled
        ? "Weekly instructor emails are turned off in admin notification settings."
        : "Each recipient is stored as an idempotent delivery job with retries.",
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

  const runId = `attendance-reminders:${today}`;
  let queued = 0;
  const failures = [];
  for (const record of todays) {
    try {
      // Guard against a repeat run sending the same nudge twice.
      if (record.checkout_reminder_sent_at) continue;
      const instructor = await db.collection("instructors").findOne({ _id: idMatch(String(record.instructor_id)) });
      const email = instructor?.email;
      if (!email) continue;

      await enqueueMailJob(db, {
        id: `${runId}:${String(record._id)}`,
        type: "attendance_reminder",
        toEmail: email,
        attendanceId: record._id,
        runId,
        payload: {
          name: record.instructor_name || instructor?.name,
          kind: "checkout",
          dateLabel: today,
        },
      });
      queued += 1;
    } catch (error) {
      failures.push({ attendance: String(record._id), reason: error?.name || "error" });
    }
  }

  await db.collection("report_delivery_runs").updateOne(
    { _id: runId },
    {
      $set: { type: "attendance_reminder", date: today, production_finished_at: new Date(), checked: todays.length, queued, producer_failures: failures.slice(0, 20), updated_at: new Date() },
      $setOnInsert: { sent: 0, failed: 0, terminal: 0, created_at: new Date() },
    },
    { upsert: true }
  );
  if (!queued) {
    await db.collection("report_delivery_runs").updateOne(
      { _id: runId },
      { $set: { status: "completed", finished_at: new Date() } }
    );
  } else {
    await db.collection("report_delivery_runs").updateOne(
      { _id: runId },
      { $set: { status: "queued" } }
    );
  }
  console.log(`Attendance reminders for ${today}: ${queued} queued of ${todays.length} open check-ins`);
  return { queued, failures };
}

reportRouter.post(
  "/cron/attendance-reminders",
  requireCronSecret,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const result = await deliverAttendanceReminders(db);
    return res.status(202).json({
      date: localDateKey(new Date()),
      status: "queued",
      ...result,
      note: "Each reminder is stored as an idempotent delivery job with retries.",
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

/**
 * Deletes attendance photographs older than the retention window.
 *
 * The photograph is the only part that expires. Its report — the checkpoints,
 * observations, evidence and summary — lives in MongoDB and stays, so an old
 * record remains fully readable with no image behind it.
 *
 * R2 and MongoDB are cleared in the same pass on purpose. A lifecycle rule on
 * the bucket alone would remove the file and leave the key on the record, and
 * the interface decides whether to offer a photo button from that key: every
 * old record would show a button that opens an error.
 *
 * ?dry=1 reports what it would remove without removing anything.
 */
reportRouter.post(
  "/cron/purge-photos",
  requireCronSecret,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const months = Number.parseInt(req.query.months, 10);
    const retentionMonths = Number.isInteger(months) && months >= 1 && months <= 60
      ? months
      : PHOTO_RETENTION_MONTHS;
    const dryRun = req.query.dry === "1" || req.query.dry === "true";

    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - retentionMonths);

    const records = await db.collection("attendance")
      .find(
        {
          check_in_time: { $lt: cutoff },
          $or: [
            { check_in_photo_key: { $type: "string" } },
            { check_out_photo_key: { $type: "string" } },
          ],
        },
        { projection: { check_in_photo_key: 1, check_out_photo_key: 1 } }
      )
      .limit(PHOTO_PURGE_BATCH)
      .toArray();

    if (dryRun) {
      return res.json({
        dry_run: true,
        retention_months: retentionMonths,
        cutoff: cutoff.toISOString(),
        records: records.length,
        photos: records.reduce(
          (total, row) => total + (row.check_in_photo_key ? 1 : 0) + (row.check_out_photo_key ? 1 : 0),
          0
        ),
      });
    }

    let deleted = 0;
    let failed = 0;
    for (const record of records) {
      const cleared = {};
      for (const field of ["check_in_photo_key", "check_out_photo_key"]) {
        const key = record[field];
        if (!key) continue;
        const result = await deletePhoto(key);
        if (result.deleted) {
          deleted += 1;
          cleared[field] = null;
        } else {
          failed += 1;
        }
      }
      // Only the keys whose objects are actually gone are cleared, so a
      // storage outage leaves the record intact for the next run rather than
      // orphaning a file nothing points at any more.
      if (Object.keys(cleared).length) {
        await db.collection("attendance").updateOne(
          { _id: record._id },
          { $set: { ...cleared, photos_purged_at: new Date() } }
        );
      }
    }

    return res.json({
      retention_months: retentionMonths,
      cutoff: cutoff.toISOString(),
      records: records.length,
      photos_deleted: deleted,
      photos_failed: failed,
      // The batch is capped, so a large backlog clears over several runs
      // rather than one request timing out part way through.
      more: records.length === PHOTO_PURGE_BATCH,
    });
  })
);
