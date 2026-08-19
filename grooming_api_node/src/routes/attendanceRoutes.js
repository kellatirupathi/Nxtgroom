import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { withMongoTransaction } from "../config/db.js";
import { runtimeConfig } from "../config/env.js";
import { idMatch, instructorScope, isElevated, requireSuperAdmin, ROLES } from "../middleware/auth.js";
import { validateImageUpload } from "../imageValidation.js";
import { normalizeInstructorImage } from "../imageProcessor.js";
import { enqueueEvaluation, evaluationFilter } from "../services/evaluationWorker.js";
import { enqueueNotification } from "../services/notificationWorker.js";
import { buildPhotoKey, deletePhoto, getPhotoUrl, uploadPhoto } from "../services/photoStorage.js";
import { canDeleteAttendance, canDeleteCheckout, getAccessSettings } from "../services/accessSettings.js";
import { attachAddressToAttendance } from "../services/geocoding.js";
import {
  asyncRoute,
  createDocument,
  dateBoundsInTimeZone,
  parsePagination,
  serializeDocument,
  dateRangeBoundsInTimeZone,
} from "../utils.js";
import { checkoutSchema, parseCoordinates, validate } from "../validation.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 4 },
  fileFilter: (_req, file, callback) => {
    const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowedTypes.has(file.mimetype)) {
      return callback(new Error("Only JPEG, PNG, and WebP image uploads are allowed"));
    }
    return callback(null, true);
  },
});

const checkInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => String(req.currentUser?.email || "unauthenticated"),
  message: { detail: "Too many check-in attempts. Please try again later." },
});

let activeCheckIns = 0;
export function checkInConcurrencyGate(_req, res, next) {
  if (activeCheckIns >= 2) {
    res.set("Retry-After", "5");
    return res.status(503).json({
      detail: "Image processing is busy. Please retry in a few seconds.",
    });
  }
  activeCheckIns += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeCheckIns = Math.max(0, activeCheckIns - 1);
    res.off("finish", release);
    res.off("close", release);
  };
  res.once("finish", release);
  res.once("close", release);
  return next();
}

const OUTBOX_DEADLINE_MS = 24 * 60 * 60 * 1000;
const INSTRUCTOR_ATTENDANCE_GUARD = "_private_attendance_guard_version";
const INTERNAL_ATTENDANCE_FIELDS = new Set([
  "_private_evaluation_outbox",
  "_private_checkin_outbox",
  "_private_checkout_outbox",
]);

export const attendanceRouter = Router();

function activeInstructorFilter(currentUser, instructorId) {
  return {
    $and: [
      { _id: idMatch(instructorId) },
      instructorScope(currentUser),
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
    ],
  };
}

function attendanceScope(currentUser) {
  // Both elevated roles see every college. Testing for SUPER_ADMIN alone left
  // an ADMIN scoped to currentUser.collegeId, which administrators do not
  // have, so the filter matched nothing and Daily Records looked empty.
  return isElevated(currentUser?.role)
    ? {}
    : { college_id: idMatch(String(currentUser.collegeId)) };
}

/**
 * Removes a check-in entirely: the record, its evaluation, its queued job and
 * its photographs.
 *
 * Photographs are normally kept indefinitely and never expired on a schedule.
 * This is the one path that removes them, because it is someone deliberately
 * erasing the check-in they belong to — leaving the images behind would retain
 * a person's photograph with no record explaining why it was held.
 *
 * The record goes last. If a photo delete fails the record is still there to
 * try again, whereas the reverse would leave images nothing points at.
 */
async function purgeAttendance(db, attendance) {
  const keys = [attendance.check_in_photo_key, attendance.check_out_photo_key].filter(Boolean);
  for (const key of keys) {
    try {
      await deletePhoto(key);
    } catch {
      // A photo already gone, or storage briefly unavailable, must not strand
      // the record: the caller asked for it to be removed.
    }
  }
  await db.collection("evaluation_jobs").deleteOne({ _id: `${attendance._id}:evaluation` });
  await db.collection("evaluations").deleteMany({ attendance_id: String(attendance._id) });
  await db.collection("attendance").deleteOne({ _id: attendance._id });
}

/**
 * Matches an open check-in belonging to today.
 *
 * The guard used to match any open check-in ever. A check-out that was never
 * done left the record open forever, so one missed check-out on Monday blocked
 * that instructor from checking in for the rest of time. A day here is a local
 * calendar day — midnight to midnight where the instructor is — so yesterday's
 * unclosed record is a missed check-out to chase, not a reason to refuse today.
 */
function openCheckInToday(instructorId) {
  const { start, end } = dateBoundsInTimeZone(undefined, runtimeConfig().appTimeZone);
  return {
    instructor_id: idMatch(String(instructorId)),
    check_out_time: null,
    check_in_time: { $gte: start, $lt: end },
  };
}

/**
 * The id of the instructor's open check-in, or null.
 *
 * Used only on the refusal path, where a duplicate check-in has already been
 * rejected and the caller needs somewhere to look. A failed lookup must not
 * turn a clear 409 into a 500, so it degrades to null.
 */
async function activeAttendanceId(db, instructorId) {
  try {
    const record = await db.collection("attendance").findOne(
      openCheckInToday(instructorId),
      { projection: { _id: 1 } },
    );
    return record ? String(record._id) : null;
  } catch {
    return null;
  }
}

function isValidEmail(value) {
  return typeof value === "string"
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function lookupIdVariants(ids) {
  const variants = [];
  const seen = new Set();
  for (const id of ids) {
    for (const variant of idMatch(String(id)).$in) {
      const key = `${variant?._bsontype || typeof variant}:${String(variant)}`;
      if (!seen.has(key)) {
        seen.add(key);
        variants.push(variant);
      }
    }
  }
  return variants;
}

/**
 * Revalidates and commits check-in after image processing. Updating the same
 * instructor document that profile mutations update gives MongoDB transactions
 * a shared write-conflict boundary: either the profile change wins and this
 * transaction retries with the new profile, or check-in wins and the profile
 * mutation retries and observes the open attendance.
 */
export async function commitGuardedCheckIn(
  db,
  {
    currentUser,
    instructorId,
    coordinates,
    normalizedImage,
    photoKey = null,
    locationAccuracyM = null,
    capturedAt = null,
  },
  runTransaction = withMongoTransaction
) {
  return runTransaction(async (session) => {
    const instructor = await db.collection("instructors").findOne(
      activeInstructorFilter(currentUser, instructorId),
      { session }
    );
    if (!instructor) return { outcome: "instructor_not_found" };
    if (!isValidEmail(instructor.email)) return { outcome: "invalid_email" };

    const activeAttendance = await db.collection("attendance").findOne(
      openCheckInToday(instructor._id),
      { session }
    );
    if (activeAttendance) return { outcome: "already_active" };

    const guard = await db.collection("instructors").updateOne(
      activeInstructorFilter(currentUser, instructorId),
      { $inc: { [INSTRUCTOR_ATTENDANCE_GUARD]: 1 } },
      { session }
    );
    if (!guard.matchedCount) return { outcome: "instructor_not_found" };

    const now = new Date();
    const evaluationDeadline = new Date(now.getTime() + OUTBOX_DEADLINE_MS);
    const evaluationPayload = {
      instructor: {
        id: String(instructor._id),
        name: instructor.name,
        email: instructor.email,
        gender: instructor.gender,
        collegeId: String(instructor.college_id),
      },
      // Only the R2 key travels through the queue. The worker downloads the
      // image when it runs, so no image bytes are ever written to MongoDB.
      photo_key: photoKey,
      mime_type: normalizedImage.mimeType,
      check_in_time: now,
      deadline_at: evaluationDeadline,
      created_at: now,
    };
    const attendance = createDocument({
      instructor_id: String(instructor._id),
      instructor_name: instructor.name,
      // instructor_role first: an instructor imported from BigQuery carries
      // their real role there and has no `role` at all, so snapshotting
      // `role` alone recorded null for 599 of 600 people and lost the
      // distinction between an INSTRUCTOR and a CENTRAL_INSTRUCTOR.
      instructor_role: instructor.instructor_role || instructor.role || null,
      college_id: String(instructor.college_id),
      boa_id: currentUser.referenceId ? String(currentUser.referenceId) : "super-admin",
      date: now,
      check_in_time: now,
      check_out_time: null,
      location_coordinates: coordinates,
      // Accuracy is kept next to the coordinates so a reading from a coarse
      // IP lookup is distinguishable from a real GPS fix.
      location_accuracy_m: locationAccuracyM,
      check_in_photo_key: photoKey,
      check_in_photo_captured_at: capturedAt || now,
      check_out_photo_key: null,
      status: "pending",
      compliance_status: null,
      remarks: "AI analysis is in progress.",
      evaluation_queue_status: "outbox_pending",
      checkin_email_status: "waiting_for_analysis",
      checkout_email_status: "not_requested",
      _private_evaluation_outbox: evaluationPayload,
      created_at: now,
      updated_at: now,
    });
    await db.collection("attendance").insertOne(attendance, { session });
    return { outcome: "created", attendance, evaluationPayload };
  });
}

export function serializeAttendance(attendance) {
  const publicAttendance = Object.fromEntries(
    Object.entries(attendance).filter(([key]) => (
      !key.startsWith("_private_") && !INTERNAL_ATTENDANCE_FIELDS.has(key)
    ))
  );
  return serializeDocument(publicAttendance);
}

attendanceRouter.post(
  "/check-in",
  checkInLimiter,
  checkInConcurrencyGate,
  upload.single("file"),
  asyncRoute(async (req, res) => {
    const validation = validateImageUpload(req.file);
    if (!validation.valid) return res.status(400).json({ detail: validation.detail });

    const instructorId = String(req.body.instructor_id || "").trim();
    if (!instructorId || instructorId.length > 100) {
      return res.status(422).json({ detail: "A valid instructor_id is required" });
    }
    const coordinates = parseCoordinates(req.body.location_coordinates);
    if (req.body.location_coordinates && !coordinates) {
      return res.status(422).json({ detail: "location_coordinates must be valid latitude,longitude" });
    }

    const db = req.app.locals.db;
    const instructor = await db.collection("instructors").findOne(
      activeInstructorFilter(req.currentUser, instructorId)
    );
    if (!instructor) return res.status(404).json({ detail: "Instructor not found" });
    if (!isValidEmail(instructor.email)) {
      return res.status(422).json({
        detail: "This instructor needs a valid email address before check-in reports can be sent.",
      });
    }

    // Return the open record's id, not just the refusal: the caller's next
    // step is almost always to look at that check-in, and without the id the
    // user has to go and find it by hand.
    const activeRecord = await db.collection("attendance").findOne(
      openCheckInToday(instructor._id)
    );
    if (activeRecord) {
      return res.status(409).json({
        detail: "This instructor already has an active check-in",
        attendance_id: String(activeRecord._id),
      });
    }

    let normalizedImage;
    try {
      normalizedImage = await normalizeInstructorImage(req.file.buffer);
    } catch {
      return res.status(400).json({
        detail: "Image could not be decoded; upload a clear JPEG, PNG, or WebP",
      });
    }

    // The photo goes to R2 and only its key is stored, so MongoDB never holds
    // image bytes. Upload before the transaction: a failure here should stop
    // the check-in rather than leave a record pointing at a missing object.
    const now = new Date();
    const photoKey = buildPhotoKey({
      instructorId: String(instructor._id),
      kind: "checkin",
      mimeType: normalizedImage.mimeType,
      now,
    });
    const upload = await uploadPhoto({
      key: photoKey,
      body: normalizedImage.buffer,
      mimeType: normalizedImage.mimeType,
      metadata: {
        instructor_id: String(instructor._id),
        kind: "checkin",
        captured_at: now.toISOString(),
        coordinates: coordinates || "",
        accuracy_m: req.body.location_accuracy_m || "",
      },
    });
    if (!upload.stored) {
      return res.status(503).json({
        detail: "Photo storage is unavailable right now. Please try again in a moment.",
      });
    }

    let committed;
    try {
      committed = await commitGuardedCheckIn(db, {
        currentUser: req.currentUser,
        instructorId,
        coordinates,
        normalizedImage,
        photoKey,
        locationAccuracyM: Number.parseInt(req.body.location_accuracy_m, 10) || null,
        capturedAt: now,
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({
          detail: "This instructor already has an active check-in",
          attendance_id: await activeAttendanceId(db, instructor._id),
        });
      }
      throw error;
    }
    if (committed.outcome === "instructor_not_found") {
      return res.status(404).json({ detail: "Instructor not found" });
    }
    if (committed.outcome === "invalid_email") {
      return res.status(422).json({
        detail: "This instructor needs a valid email address before check-in reports can be sent.",
      });
    }
    if (committed.outcome === "already_active") {
      return res.status(409).json({
        detail: "This instructor already has an active check-in",
        attendance_id: await activeAttendanceId(db, instructor._id),
      });
    }
    const { attendance, evaluationPayload } = committed;
    try {
      await enqueueEvaluation(db, {
        attendanceId: attendance._id,
        instructor: evaluationPayload.instructor,
        photoKey: evaluationPayload.photo_key,
        mimeType: evaluationPayload.mime_type,
        checkInTime: evaluationPayload.check_in_time,
        deadlineAt: evaluationPayload.deadline_at,
      });
    } catch (error) {
      console.error(`Evaluation outbox ${attendance._id} remains pending (${error.name || "ERROR"})`);
    }

    // Fire-and-forget: the response has already been decided, so a slow or
    // failing address lookup cannot delay or fail the check-in. The record
    // keeps its coordinates either way.
    if (coordinates) {
      void attachAddressToAttendance(db, attendance._id, coordinates);
    }

    return res.status(202).json({
      message: "Check-in successful. AI analysis is queued.",
      attendance_id: attendance._id,
    });
  })
);

attendanceRouter.post(
  "/check-out",
  // Accepts multipart so a check-out photo can be attached. The photo is
  // optional: check-out must still work when a camera is unavailable.
  upload.single("file"),
  validate(checkoutSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const checkOutTime = new Date();
    const scope = attendanceScope(req.currentUser);
    const candidate = await db.collection("attendance").findOne(
      {
        instructor_id: idMatch(req.validatedBody.instructor_id),
        check_out_time: null,
        ...scope,
      },
      { sort: { check_in_time: -1 } }
    );
    if (!candidate) {
      return res.status(400).json({ detail: "No active check-in found to check out" });
    }

    const instructor = await db.collection("instructors").findOne({
      _id: idMatch(String(candidate.instructor_id)),
    });
    const recipient = isValidEmail(instructor?.email) ? instructor.email : null;
    const notificationDeadline = new Date(checkOutTime.getTime() + OUTBOX_DEADLINE_MS);
    const checkoutPayload = {
      to_email: recipient,
      report: {
        instructorName: candidate.instructor_name || instructor?.name || "Instructor",
        checkInTime: candidate.check_in_time,
        checkOutTime,
        status: candidate.status,
        remarks: candidate.remarks,
      },
      deadline_at: notificationDeadline,
      created_at: checkOutTime,
    };
    // Store the check-out photo when one was supplied. A failure here is
    // logged and skipped rather than blocking the check-out itself, which is
    // the record that actually matters for attendance.
    let checkOutPhotoKey = null;
    if (req.file) {
      const validation = validateImageUpload(req.file);
      if (!validation.valid) return res.status(400).json({ detail: validation.detail });
      try {
        const normalized = await normalizeInstructorImage(req.file.buffer);
        const key = buildPhotoKey({
          instructorId: String(candidate.instructor_id),
          kind: "checkout",
          mimeType: normalized.mimeType,
          now: checkOutTime,
        });
        const upload = await uploadPhoto({
          key,
          body: normalized.buffer,
          mimeType: normalized.mimeType,
          metadata: {
            instructor_id: String(candidate.instructor_id),
            kind: "checkout",
            captured_at: checkOutTime.toISOString(),
            coordinates: parseCoordinates(req.body?.location_coordinates) || "",
          },
        });
        if (upload.stored) checkOutPhotoKey = key;
      } catch (error) {
        console.error(`Check-out photo not stored: ${error?.name || "Error"}`);
      }
    }

    const checkoutCoordinates = parseCoordinates(req.body?.location_coordinates);
    const checkoutSet = {
      check_out_time: checkOutTime,
      ...(checkOutPhotoKey ? { check_out_photo_key: checkOutPhotoKey } : {}),
      ...(checkoutCoordinates ? { check_out_coordinates: checkoutCoordinates } : {}),
      updated_at: checkOutTime,
      checkout_email_status: recipient ? "outbox_pending" : "skipped_no_email",
      ...(recipient ? { _private_checkout_outbox: checkoutPayload } : {}),
    };
    const result = await db.collection("attendance").findOneAndUpdate(
      {
        _id: candidate._id,
        check_out_time: null,
        ...scope,
      },
      {
        $set: checkoutSet,
        ...(!recipient ? { $unset: { _private_checkout_outbox: "" } } : {}),
      },
      { returnDocument: "after" }
    );
    const attendance = result?.value || result;
    if (!attendance) {
      return res.status(409).json({ detail: "This attendance was already checked out" });
    }

    try {
      await enqueueNotification(db, {
        attendanceId: attendance._id,
        type: "checkout",
        toEmail: checkoutPayload.to_email,
        report: checkoutPayload.report,
        deadlineAt: checkoutPayload.deadline_at,
      });
    } catch (error) {
      console.error(`Checkout outbox ${attendance._id} remains pending (${error.name || "ERROR"})`);
    }

    // The check-out photo is assessed the same way the check-in one is, when
    // there is one. Queued after the record is committed and failures are
    // swallowed: the check-out itself is the thing that matters for
    // attendance, and it has already succeeded by this point.
    if (checkOutPhotoKey) {
      try {
        await enqueueEvaluation(db, {
          attendanceId: attendance._id,
          kind: "checkout",
          instructor: {
            id: String(candidate.instructor_id),
            name: attendance.instructor_name || instructor?.name || "Instructor",
            email: recipient || instructor?.email || null,
            gender: instructor?.gender || null,
          },
          photoKey: checkOutPhotoKey,
          mimeType: "image/jpeg",
          checkInTime: checkOutTime,
        });
        await db.collection("attendance").updateOne(
          { _id: attendance._id },
          { $set: { checkout_evaluation_queue_status: "queued" } }
        );
      } catch (error) {
        console.error(`Checkout evaluation not queued for ${attendance._id} (${error.name || "ERROR"})`);
      }
    }

    return res.json({
      message: recipient
        ? "Check-out successful. Email confirmation is queued."
        : "Check-out successful, but no email was sent because the instructor email is missing or invalid.",
      // Returned so the caller can follow the check-out analysis, the same way
      // it follows the check-in one.
      attendance_id: String(attendance._id),
      analysis_queued: Boolean(checkOutPhotoKey),
    });
  })
);

attendanceRouter.get(
  "/today",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    let dateFilter;
    let pagination;
    try {
      const zone = runtimeConfig().appTimeZone;
      // A range wins when either end is given; otherwise this stays the
      // single-day endpoint it has always been, so existing callers and saved
      // links keep working.
      const ranged = req.query.from !== undefined || req.query.to !== undefined;
      if (ranged) {
        // An empty bound means that side is open, which is how "all time"
        // arrives: both present and both blank.
        const blankToUndefined = (value) => (value === "" ? undefined : value);
        const { start, end } = dateRangeBoundsInTimeZone(
          blankToUndefined(req.query.from),
          blankToUndefined(req.query.to),
          zone
        );
        dateFilter = {};
        if (start) dateFilter.$gte = start;
        if (end) dateFilter.$lt = end;
      } else {
        const { start, end } = dateBoundsInTimeZone(req.query.date, zone);
        dateFilter = { $gte: start, $lt: end };
      }
      pagination = parsePagination(req.query, {
        defaultLimit: 200,
        maxLimit: 1000,
      });
    } catch (error) {
      if (error instanceof RangeError) {
        return res.status(422).json({ detail: error.message });
      }
      throw error;
    }
    const attendances = await db.collection("attendance")
      // An unbounded range still filters on the field so the same index is
      // used; $exists alone would fall back to a collection scan.
      .find({
        ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}),
        ...attendanceScope(req.currentUser),
      })
      .project({
        _private_evaluation_outbox: 0,
        _private_checkin_outbox: 0,
        _private_checkout_outbox: 0,
      })
      .sort({ check_in_time: -1, _id: -1 })
      .skip(pagination.offset)
      .limit(pagination.limit)
      .toArray();

    // Every row is looked up now, not only the ones missing a name snapshot:
    // the report token lives on the instructor and the table needs it to build
    // the public report links.
    const instructorIds = [...new Set(attendances.map((row) => String(row.instructor_id)))];
    const legacyInstructors = instructorIds.length
      ? await db.collection("instructors").find(
          { _id: { $in: lookupIdVariants(instructorIds) } },
          // instructor_role as well as role: an instructor imported from
          // BigQuery carries only the former, so projecting role alone left
          // every synced person showing as "Unknown".
          { projection: { name: 1, role: 1, instructor_role: 1, college_id: 1, report_token: 1 } }
        ).toArray()
      : [];
    const instructorMap = new Map(legacyInstructors.map((row) => [String(row._id), row]));
    const collegeIds = [...new Set(attendances
      .map((attendance) => (
        attendance.college_id
        || instructorMap.get(String(attendance.instructor_id))?.college_id
      ))
      .filter(Boolean)
      .map(String))];
    const colleges = collegeIds.length
      ? await db.collection("colleges").find({
          _id: { $in: lookupIdVariants(collegeIds) },
        }).toArray()
      : [];
    const collegeMap = new Map(colleges.map((row) => [String(row._id), row.name]));
    return res.json(attendances.map((attendance) => {
      const instructor = instructorMap.get(String(attendance.instructor_id));
      const collegeId = attendance.college_id || instructor?.college_id || null;
      return {
        ...serializeAttendance(attendance),
        instructor_name: attendance.instructor_name || instructor?.name || "Unknown",
        instructor_role: attendance.instructor_role
          || instructor?.instructor_role
          || instructor?.role
          || "Unknown",
        college_name: collegeId
          ? (collegeMap.get(String(collegeId)) || "Unknown College")
          : "No College",
        // Lets the table link straight to the public report an instructor
        // receives by email, rather than a second internal-only view of it.
        report_token: instructor?.report_token || null,
      };
    }));
  })
);

/**
 * One attendance record by id, so the detail page can be opened directly from
 * a URL. Without this the page could only render a record handed to it by the
 * list, and a refresh or a shared link showed an empty screen.
 */
attendanceRouter.get(
  "/:attendanceId",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const attendance = await db.collection("attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    // Records written before the snapshot was fixed carry no role, and this
    // route is what serves a detail page opened directly from its URL. Without
    // the lookup the role reads blank there while the list shows it correctly.
    const instructor = await db.collection("instructors").findOne(
      { _id: idMatch(String(attendance.instructor_id)) },
      { projection: { name: 1, role: 1, instructor_role: 1, report_token: 1 } }
    );
    return res.json({
      ...serializeAttendance(attendance),
      instructor_name: attendance.instructor_name || instructor?.name || "Unknown",
      instructor_role: attendance.instructor_role
        || instructor?.instructor_role
        || instructor?.role
        || "Unknown",
      report_token: instructor?.report_token || null,
    });
  })
);

attendanceRouter.get(
  "/:attendanceId/evaluation",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const attendance = await db.collection("attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    // ?kind=checkout selects the check-out assessment. The default stays the
    // check-in one, so every existing caller keeps the report it asked for.
    const kind = req.query.kind === "checkout" ? "checkout" : "checkin";
    const evaluation = await db.collection("evaluations").findOne(
      evaluationFilter(String(attendance._id), kind)
    );
    if (!evaluation) {
      // 204, not 404. A half with no evaluation is an ordinary state — no
      // photo was taken, or the analysis has not finished — and returning an
      // error made the page paint it red as though something had broken.
      return res.status(204).end();
    }
    return res.json(serializeDocument(evaluation));
  })
);

/**
 * Lightweight status for the check-in screen to poll while analysis runs.
 * Deliberately small: it is requested every few seconds and must not carry
 * the full evaluation payload.
 */
attendanceRouter.get(
  "/:attendanceId/status",
  asyncRoute(async (req, res) => {
    const attendance = await req.app.locals.db.collection("attendance").findOne(
      { _id: idMatch(req.params.attendanceId), ...attendanceScope(req.currentUser) },
      {
        projection: {
          status: 1,
          compliance_status: 1,
          remarks: 1,
          evaluation_queue_status: 1,
          check_out_photo_key: 1,
          checkout_compliance_status: 1,
          checkout_remarks: 1,
          checkout_evaluation_queue_status: 1,
          updated_at: 1,
        },
      }
    );
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    // Each half is assessed separately, so the caller says which one it is
    // waiting on. The default stays the check-in, which is what every existing
    // caller means.
    if (req.query.kind === "checkout") {
      const queueStatus = attendance.checkout_evaluation_queue_status || null;
      return res.json({
        attendance_id: String(attendance._id),
        // No photo means nothing was ever queued, so the caller must not be
        // left polling for an analysis that will never arrive.
        status: attendance.checkout_compliance_status
          ? String(attendance.checkout_compliance_status).toLowerCase()
          : "pending",
        compliance_status: attendance.checkout_compliance_status || null,
        remarks: attendance.checkout_remarks || null,
        queue_status: queueStatus,
        settled: queueStatus === "completed" || !attendance.check_out_photo_key,
        updated_at: attendance.updated_at || null,
      });
    }

    return res.json({
      attendance_id: String(attendance._id),
      status: attendance.status || "pending",
      compliance_status: attendance.compliance_status || null,
      remarks: attendance.remarks || null,
      queue_status: attendance.evaluation_queue_status || null,
      // Lets the client stop polling instead of guessing from the status text.
      settled: attendance.status !== "pending",
      updated_at: attendance.updated_at || null,
    });
  })
);

/**
 * Runs the grooming analysis again on the photo already in R2.
 *
 * Used when a result looks wrong or the first attempt failed. The photo is
 * never re-uploaded, so this cannot change what was captured at check-in — it
 * only re-runs the model over the same image.
 */
attendanceRouter.post(
  "/:attendanceId/reanalyse",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const attendance = await db.collection("attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });
    if (!attendance.check_in_photo_key) {
      return res.status(422).json({
        detail: "This check-in has no stored photo, so it cannot be analysed again.",
      });
    }

    const instructor = await db.collection("instructors").findOne({
      _id: idMatch(String(attendance.instructor_id)),
    });

    const now = new Date();
    // Clear the finished job so the worker treats this as fresh work; the
    // upsert in enqueueEvaluation only writes on insert.
    await db.collection("evaluation_jobs").deleteOne({
      _id: `${attendance._id}:evaluation`,
    });
    await db.collection("evaluations").deleteMany({
      attendance_id: String(attendance._id),
    });
    await db.collection("attendance").updateOne(
      { _id: attendance._id },
      {
        $set: {
          status: "pending",
          compliance_status: null,
          remarks: "AI analysis is in progress.",
          evaluation_queue_status: "queued",
          updated_at: now,
        },
      }
    );

    await enqueueEvaluation(db, {
      attendanceId: attendance._id,
      instructor: {
        id: String(attendance.instructor_id),
        name: attendance.instructor_name || instructor?.name || "Instructor",
        email: instructor?.email || null,
        gender: instructor?.gender || null,
        collegeId: String(attendance.college_id || instructor?.college_id || ""),
      },
      photoKey: attendance.check_in_photo_key,
      mimeType: "image/jpeg",
      checkInTime: attendance.check_in_time,
      deadlineAt: new Date(now.getTime() + OUTBOX_DEADLINE_MS),
    });

    return res.status(202).json({
      message: "Re-analysis queued.",
      attendance_id: String(attendance._id),
    });
  })
);

/**
 * Time-limited link to a stored photo. The bucket is private, so this is the
 * only way to view one; the URL is generated per request and expires, rather
 * than being stored anywhere it could leak.
 */
attendanceRouter.get(
  "/:attendanceId/photo/:kind",
  asyncRoute(async (req, res) => {
    const kind = req.params.kind === "checkout" ? "checkout" : "checkin";
    const attendance = await req.app.locals.db.collection("attendance").findOne(
      { _id: idMatch(req.params.attendanceId), ...attendanceScope(req.currentUser) },
      { projection: { check_in_photo_key: 1, check_out_photo_key: 1 } }
    );
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    const key = kind === "checkout"
      ? attendance.check_out_photo_key
      : attendance.check_in_photo_key;
    if (!key) return res.status(404).json({ detail: "No photo was stored for this record" });

    const url = await getPhotoUrl(key, { expiresIn: 900 });
    if (!url) return res.status(503).json({ detail: "Photo storage is unavailable right now" });

    return res.json({ url, expires_in: 900 });
  })
);

/**
 * Permanently removes a check-in.
 *
 * Scoped like every other read: a BOA can only reach records at their own
 * college, so the capability toggle governs whether they may delete, never
 * whose records they can see.
 */
attendanceRouter.delete(
  "/:attendanceId",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const settings = await getAccessSettings(db);
    if (!canDeleteAttendance(req.currentUser, settings)) {
      return res.status(403).json({
        detail: "You do not have permission to delete attendance records",
      });
    }

    const attendance = await db.collection("attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    await purgeAttendance(db, attendance);
    return res.json({ message: "Attendance record deleted" });
  })
);

/**
 * Removes only the check-out half, leaving the check-in and its report intact.
 *
 * A record cannot exist without a check-in, so deleting that is deleting the
 * record — which is what DELETE /:attendanceId does. This is the other half:
 * the time, the photograph, the location and the check-out assessment go, and
 * the instructor is back to being checked in.
 */
attendanceRouter.delete(
  "/:attendanceId/check-out",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const settings = await getAccessSettings(db);
    if (!canDeleteCheckout(req.currentUser, settings)) {
      return res.status(403).json({
        detail: "You do not have permission to delete check-outs",
      });
    }

    const attendance = await db.collection("attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });
    if (!attendance.check_out_time) {
      return res.status(409).json({ detail: "This record has no check-out to delete" });
    }

    // The photograph goes first. If it fails the record is untouched and the
    // delete can be retried, where the reverse would leave an image in storage
    // that nothing points at.
    if (attendance.check_out_photo_key) {
      try {
        await deletePhoto(attendance.check_out_photo_key);
      } catch {
        // Already gone, or storage briefly unavailable; neither should strand
        // the check-out the caller asked to remove.
      }
    }
    await db.collection("evaluation_jobs").deleteOne({
      _id: `${attendance._id}:evaluation:checkout`,
    });
    await db.collection("evaluations").deleteMany(
      evaluationFilter(String(attendance._id), "checkout")
    );
    await db.collection("attendance").updateOne(
      { _id: attendance._id },
      {
        $set: { check_out_time: null, updated_at: new Date() },
        $unset: {
          check_out_photo_key: "",
          check_out_coordinates: "",
          checkout_compliance_status: "",
          checkout_remarks: "",
          checkout_image_quality: "",
          checkout_analysis_completed_at: "",
          checkout_evaluation_queue_status: "",
          checkout_email_status: "",
          checkout_reminder_sent_at: "",
        },
      }
    );
    return res.json({ message: "Check-out deleted" });
  })
);
