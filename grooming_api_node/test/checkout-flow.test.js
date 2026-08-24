import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("photographed checkout analyses directly before creating its email job", async () => {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  const routeName = source.indexOf('"/check-out"');
  const start = source.lastIndexOf("attendanceRouter.post(", routeName);
  const nextRouteName = source.indexOf('"/today"', routeName);
  const end = source.lastIndexOf("attendanceRouter.get(", nextRouteName);
  assert.ok(start >= 0 && end > start, "checkout route must remain identifiable");

  const checkoutRoute = source.slice(start, end);
  const analysisAt = checkoutRoute.indexOf("evaluateCheckoutNow(db");
  const notificationAt = checkoutRoute.indexOf("enqueueNotification(db");

  assert.ok(analysisAt >= 0, "checkout must run direct analysis");
  assert.ok(notificationAt > analysisAt, "checkout email must be created after its report");
  assert.equal(
    checkoutRoute.includes("enqueueEvaluation(db"),
    false,
    "checkout must not create an evaluation queue job"
  );
  assert.ok(
    checkoutRoute.includes("attendanceOnLocalDay(req.validatedBody.instructor_id, checkOutTime)"),
    "checkout must use today's attendance rather than an older open record"
  );
  assert.ok(
    checkoutRoute.indexOf("checkoutAvailability(candidate)") < checkoutRoute.indexOf("normalizeInstructorImage"),
    "a duplicate checkout must be refused before its photo is processed"
  );
});

test("a failed checkout photo can be retried without adding an AI queue", async () => {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  const routeName = source.indexOf('"/:attendanceId/checkout-photo"');
  const start = source.lastIndexOf("attendanceRouter.post(", routeName);
  const nextRouteName = source.indexOf('"/:attendanceId/evaluation"', routeName);
  const end = source.lastIndexOf("attendanceRouter.get(", nextRouteName);
  assert.ok(start >= 0 && end > start, "checkout photo recovery route must remain identifiable");

  const retryRoute = source.slice(start, end);
  assert.ok(retryRoute.includes("uploadPhoto("), "retry must store the missing photo");
  assert.ok(retryRoute.includes("evaluateCheckoutNow(db"), "retry must analyse directly");
  assert.ok(retryRoute.includes("enqueueNotification(db"), "retry must email only after analysis");
  assert.equal(
    retryRoute.includes("enqueueEvaluation(db"),
    false,
    "retry must not recreate the removed checkout evaluation queue"
  );
});

test("bulk attendance deletion is restricted to elevated administrators", async () => {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  const routeName = source.indexOf('"/bulk-delete"');
  const start = source.lastIndexOf("attendanceRouter.post(", routeName);
  const end = source.indexOf("attendanceRouter.delete(", routeName);
  assert.ok(start >= 0 && end > start, "bulk delete route must remain identifiable");

  const bulkRoute = source.slice(start, end);
  assert.ok(bulkRoute.includes("requireSuperAdmin"));
  assert.ok(bulkRoute.includes("await purgeAttendance(db, attendance)"));
  assert.ok(bulkRoute.includes("attendanceIds.length > 100"));
});
