import { Router } from "express";
import { withMongoTransaction } from "../config/db.js";
import { idMatch, instructorScope, isElevated, requireSuperAdmin, ROLES } from "../middleware/auth.js";
import { asyncRoute, createDocument, parsePagination, serializeDocument } from "../utils.js";
import { instructorGenderSchema, instructorSchema, validate } from "../validation.js";

export const instructorRouter = Router();
const COLLEGE_ASSIGNMENT_GUARD = "_private_assignment_guard_version";
const INSTRUCTOR_PAGE_LIMIT = 100;
const DAILY_FEEDBACK_LIMIT = 100;

function activeFilter(extra = {}) {
  return {
    $and: [
      extra,
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
    ],
  };
}

function feedbackStatus(status) {
  if (status === "pending") return "PENDING";
  if (status === "error") return "ERROR";
  // Records evaluated before the review flag was removed still carry this
  // status. They were compliant results that had been flagged, so that is
  // what they report now; the stored value is left untouched.
  if (status === "review_required" || status === "needs_review") return "COMPLIANT";
  if (status === "non_compliant" || status === "fail") return "FLAGGED";
  if (status === "compliant" || status === "done") return "COMPLIANT";
  return "UNKNOWN";
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

export async function loadRecentInstructorFeedbacks(db, instructorIds) {
  if (!instructorIds.length) return [];
  const normalizedIdField = "_private_paging_instructor_id";
  const normalizedDateField = "_private_paging_feedback_date";
  const rankField = "_private_paging_feedback_rank";
  return db.collection("attendance").aggregate([
    { $match: { instructor_id: { $in: lookupIdVariants(instructorIds) } } },
    {
      $project: {
        _id: 1,
        instructor_id: 1,
        date: 1,
        status: 1,
        remarks: 1,
      },
    },
    {
      $set: {
        [normalizedIdField]: { $toString: "$instructor_id" },
        [normalizedDateField]: {
          $convert: { input: "$date", to: "date", onError: null, onNull: null },
        },
      },
    },
    { $match: { [normalizedDateField]: { $ne: null } } },
    // $documentNumber requires a single-key sortBy, so the _id tiebreaker is
    // applied here instead; $setWindowFields preserves this incoming order
    // for rows that share a date.
    { $sort: { [normalizedIdField]: 1, [normalizedDateField]: -1, _id: -1 } },
    {
      $setWindowFields: {
        partitionBy: `$${normalizedIdField}`,
        sortBy: { [normalizedDateField]: -1 },
        output: { [rankField]: { $documentNumber: {} } },
      },
    },
    { $match: { [rankField]: { $lte: DAILY_FEEDBACK_LIMIT } } },
    { $sort: { [normalizedIdField]: 1, [normalizedDateField]: -1, _id: -1 } },
    { $unset: [normalizedIdField, normalizedDateField, rankField] },
    { $limit: instructorIds.length * DAILY_FEEDBACK_LIMIT },
  ], { allowDiskUse: true }).toArray();
}

export async function createInstructorGuarded(
  db,
  input,
  runTransaction = withMongoTransaction
) {
  return runTransaction(async (session) => {
    const college = await db.collection("colleges").findOne(
      activeFilter({ _id: idMatch(input.college_id) }),
      { session }
    );
    if (!college) return { outcome: "college_not_found" };
    if (await db.collection("instructors").findOne(
      { employee_id: input.employee_id },
      { session }
    )) {
      return { outcome: "duplicate_employee_id" };
    }
    const collegeGuard = await db.collection("colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $inc: { [COLLEGE_ASSIGNMENT_GUARD]: 1 } },
      { session }
    );
    if (!collegeGuard.matchedCount) return { outcome: "college_not_found" };

    const now = new Date();
    const instructor = createDocument({
      ...input,
      college_id: String(college._id),
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    await db.collection("instructors").insertOne(instructor, { session });
    return { outcome: "created", instructor };
  });
}

export async function updateInstructorGuarded(
  db,
  instructorId,
  input,
  runTransaction = withMongoTransaction
) {
  return runTransaction(async (session) => {
    const existing = await db.collection("instructors").findOne(
      activeFilter({ _id: idMatch(instructorId) }),
      { session }
    );
    if (!existing) return { outcome: "not_found" };

    const activeAttendance = await db.collection("attendance").findOne(
      {
        instructor_id: idMatch(String(existing._id)),
        check_out_time: null,
      },
      { session }
    );
    if (activeAttendance) return { outcome: "active_attendance" };

    const college = await db.collection("colleges").findOne(
      activeFilter({ _id: idMatch(input.college_id) }),
      { session }
    );
    if (!college) return { outcome: "college_not_found" };

    const duplicate = await db.collection("instructors").findOne(
      {
        employee_id: input.employee_id,
        _id: { $ne: existing._id },
      },
      { session }
    );
    if (duplicate) return { outcome: "duplicate_employee_id" };

    const collegeGuard = await db.collection("colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $inc: { [COLLEGE_ASSIGNMENT_GUARD]: 1 } },
      { session }
    );
    if (!collegeGuard.matchedCount) return { outcome: "college_not_found" };

    const result = await db.collection("instructors").updateOne(
      activeFilter({ _id: existing._id }),
      { $set: { ...input, college_id: String(college._id), updated_at: new Date() } },
      { session }
    );
    return result.matchedCount
      ? { outcome: "updated" }
      : { outcome: "not_found" };
  });
}

export async function deleteInstructorGuarded(
  db,
  instructorId,
  runTransaction = withMongoTransaction
) {
  return runTransaction(async (session) => {
    const existing = await db.collection("instructors").findOne(
      activeFilter({ _id: idMatch(instructorId) }),
      { session }
    );
    if (!existing) return { outcome: "not_found" };

    const activeAttendance = await db.collection("attendance").findOne(
      {
        instructor_id: idMatch(String(existing._id)),
        check_out_time: null,
      },
      { session }
    );
    if (activeAttendance) return { outcome: "active_attendance" };

    const now = new Date();
    const result = await db.collection("instructors").updateOne(
      activeFilter({ _id: existing._id }),
      { $set: { deleted_at: now, updated_at: now } },
      { session }
    );
    return result.matchedCount
      ? { outcome: "deleted" }
      : { outcome: "not_found" };
  });
}

instructorRouter.post(
  "/",
  requireSuperAdmin,
  validate(instructorSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    let result;
    try {
      result = await createInstructorGuarded(db, req.validatedBody);
    } catch (error) {
      if (error.code === 11000) {
        return res.status(400).json({ detail: "Instructor Employee ID exists" });
      }
      throw error;
    }
    if (result.outcome === "college_not_found") {
      return res.status(400).json({ detail: "Selected college does not exist" });
    }
    if (result.outcome === "duplicate_employee_id") {
      return res.status(400).json({ detail: "Instructor Employee ID exists" });
    }
    return res.status(201).json({
      message: "Instructor created successfully",
      id: result.instructor._id,
    });
  })
);

instructorRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    let pagination;
    try {
      pagination = parsePagination(req.query, {
        defaultLimit: INSTRUCTOR_PAGE_LIMIT,
        maxLimit: INSTRUCTOR_PAGE_LIMIT,
      });
    } catch (error) {
      if (error instanceof RangeError) {
        return res.status(422).json({ detail: error.message });
      }
      throw error;
    }
    const instructors = await db.collection("instructors")
      .find(activeFilter(instructorScope(req.currentUser)))
      .sort({ name: 1, _id: 1 })
      .skip(pagination.offset)
      .limit(pagination.limit)
      .toArray();
    const instructorIds = instructors.map((row) => String(row._id));
    const attendances = await loadRecentInstructorFeedbacks(db, instructorIds);
    const grouped = new Map();
    for (const attendance of attendances) {
      const rows = grouped.get(String(attendance.instructor_id)) || [];
      if (rows.length < 100) rows.push(attendance);
      grouped.set(String(attendance.instructor_id), rows);
    }

    return res.json(instructors.map((instructor) => {
      const serialized = serializeDocument(instructor);
      for (const key of Object.keys(serialized)) {
        if (key.startsWith("_private_")) delete serialized[key];
      }
      // Whether an address exists is not the address itself, and the two were
      // being conflated: a BOA cannot see the email, so the attendance screen
      // reported "No email on record" for instructors who have one. Sent for
      // everybody so the interface can tell absence apart from permission.
      serialized.has_email = Boolean(instructor.email);
      // Contact details are visible to both elevated roles; a BOA still only
      // sees the instructors at their own college, without contact details.
      if (!isElevated(req.currentUser.role)) {
        delete serialized.email;
        delete serialized.phone_no;
      }
      serialized.daily_feedbacks = (grouped.get(String(instructor._id)) || [])
        .filter((attendance) => attendance.date && !Number.isNaN(new Date(attendance.date).getTime()))
        .map((attendance) => {
          const overallStatus = feedbackStatus(attendance.status);
          return {
            date: new Date(attendance.date).toISOString(),
            overall_status: overallStatus,
            detailed_report: {
              overall_status: overallStatus,
              ai_summary: attendance.remarks || "",
            },
          };
        });
      return serialized;
    }));
  })
);

instructorRouter.put(
  "/:instructorId",
  requireSuperAdmin,
  validate(instructorSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    let result;
    try {
      result = await updateInstructorGuarded(
        db,
        req.params.instructorId,
        req.validatedBody
      );
    } catch (error) {
      if (error.code === 11000) {
        return res.status(400).json({ detail: "Instructor Employee ID exists" });
      }
      throw error;
    }
    if (result.outcome === "not_found") {
      return res.status(404).json({ detail: "Instructor not found" });
    }
    if (result.outcome === "active_attendance") {
      return res.status(409).json({
        detail: "Check out this instructor before changing their profile",
      });
    }
    if (result.outcome === "college_not_found") {
      return res.status(400).json({ detail: "Selected college does not exist" });
    }
    if (result.outcome === "duplicate_employee_id") {
      return res.status(400).json({ detail: "Instructor Employee ID exists" });
    }
    return res.json({ message: "Instructor updated successfully" });
  })
);

/**
 * Sets gender alone.
 *
 * The AI is given the instructor's gender so it compares against the right
 * reference photos; synced instructors have none, so they are currently
 * judged against both men's and women's examples. The full update route
 * cannot fix that — it requires a college and email the roster never
 * supplied — so this narrow route exists to make the field settable from the
 * table without touching anything else on the record.
 */
instructorRouter.patch(
  "/:instructorId/gender",
  requireSuperAdmin,
  validate(instructorGenderSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const result = await db.collection("instructors").updateOne(
      activeFilter({ _id: idMatch(req.params.instructorId) }),
      { $set: { gender: req.validatedBody.gender, updated_at: new Date() } }
    );
    if (!result.matchedCount) {
      return res.status(404).json({ detail: "Instructor not found" });
    }
    return res.json({ message: "Gender updated", gender: req.validatedBody.gender });
  })
);

instructorRouter.delete(
  "/:instructorId",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const result = await deleteInstructorGuarded(db, req.params.instructorId);
    if (result.outcome === "not_found") {
      return res.status(404).json({ detail: "Instructor not found" });
    }
    if (result.outcome === "active_attendance") {
      return res.status(409).json({
        detail: "Check out this instructor before deleting their profile",
      });
    }
    return res.json({ message: "Instructor deleted successfully" });
  })
);
