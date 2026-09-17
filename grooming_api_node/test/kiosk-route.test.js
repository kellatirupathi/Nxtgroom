import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { checkoutAvailability } from "../src/routes/attendanceRoutes.js";
import { decideKioskAction, KIOSK_ACTIONS } from "../src/services/kioskAction.js";

/**
 * The attendance endpoint that has no buttons.
 *
 * One photograph decides whether somebody arrived or left, and nobody reviews
 * the result. The properties pinned here are the ones that fail quietly: a photo
 * stored for a record that was never written, an unrecognised face closing a
 * session it cannot identify, or a literal path read as an attendance id.
 */

async function routeSource(path) {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  const name = source.indexOf(`"${path}"`);
  const start = source.lastIndexOf("attendanceRouter.post(", name);
  const after = source.indexOf("attendanceRouter.post(", name);
  return { source, route: source.slice(start, after > start ? after : undefined) };
}

test("/auto is registered before any parameterised route", async () => {
  // Express matches in registration order, so a literal path declared after
  // "/:attendanceId/..." is read as an attendance id and never runs. This has
  // been the failure twice in this work, so it is asserted rather than assumed.
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");

  // Read the registrations themselves rather than any occurrence of the text:
  // the docblock above this very route quotes "/:attendanceId/..." while
  // explaining the hazard, and matching that comment made this test fail while
  // the ordering was correct.
  //
  // Scoped to POST, because Express only resolves a path against routes of the
  // same method: a GET "/:attendanceId" cannot shadow a POST "/auto".
  const posts = [...source.matchAll(/attendanceRouter\.post\(\s*"([^"]+)"/g)]
    .map((match) => match[1]);

  const auto = posts.indexOf("/auto");
  const firstParameterised = posts.findIndex((path) => path.startsWith("/:"));
  assert.ok(auto >= 0, "the kiosk route must exist");
  assert.ok(firstParameterised >= 0, "there should be parameterised POST routes to order against");
  assert.ok(
    auto < firstParameterised,
    `/auto must be registered before the first parameterised POST route, got ${posts.join(", ")}`,
  );
});

test("an outcome that records nothing stores no photograph", async () => {
  // Too early and already-done both return before the upload. A photograph kept
  // for a record that was never written is somebody's picture with nothing
  // explaining why it is held.
  //
  // The upload is started rather than awaited now, so the thing to order
  // against is where it begins, not a helper that waited for it.
  const { route } = await routeSource("/auto");
  const refusal = route.indexOf("KIOSK_ACTIONS.TOO_EARLY || action === KIOSK_ACTIONS.ALREADY_DONE");
  const store = route.indexOf("uploadPhoto(");
  assert.ok(refusal >= 0, "the route must handle the outcomes that record nothing");
  assert.ok(store > refusal, "nothing may be stored before those outcomes have returned");
});

test("the tablet is not made to wait for the upload", async () => {
  // Storing the photograph is the slowest step in the route - 400-900ms against
  // R2, where recognition is 200-400ms - and the person standing at the tablet
  // has no reason to wait for it. The upload is started and its promise carried
  // forward, so the identity and the record decide the reply.
  const { route } = await routeSource("/auto");
  assert.ok(
    /const uploading = uploadPhoto\(/.test(route),
    "the upload must be started without being awaited",
  );
  assert.equal(
    route.includes("await uploadPhoto("),
    false,
    "awaiting the upload puts R2 back on the path to the reply",
  );
});

test("analysis is queued only once the photograph has actually landed", async () => {
  // The worker downloads the photograph by key, and is woken as soon as a job
  // exists. Queueing before the bytes arrive would send it to fetch an object
  // that is not there yet, so the enqueue waits even though the reply does not.
  const { route } = await routeSource("/auto");
  for (const [label, offset] of [["check-in", 0], ["check-out", 1]]) {
    const settle = route.indexOf("settleUpload(", offset === 0 ? 0 : route.indexOf("KIOSK_ACTIONS.CHECK_IN"));
    assert.ok(settle >= 0, `${label} must settle the upload`);
  }
  // Every enqueue in this route sits inside a settleUpload continuation.
  const enqueues = [...route.matchAll(/enqueueEvaluation\(/g)].map((match) => match.index);
  assert.ok(enqueues.length >= 2, "both halves queue an evaluation");
  for (const at of enqueues) {
    const before = route.slice(0, at);
    const lastSettle = before.lastIndexOf("settleUpload(");
    const lastReturn = before.lastIndexOf("return res.status");
    assert.ok(
      lastSettle > lastReturn,
      "an evaluation must be queued from inside a settled upload, not before one",
    );
  }
});

test("a photograph that never arrives does not leave a record pointing at it", async () => {
  // Attendance matters more than its picture, so the record is kept. But the
  // key has to be cleared, or the report offers a photo button that opens an
  // error and the worker is queued for an image it can never download.
  const { route } = await routeSource("/auto");
  assert.ok(route.includes("photo_storage_failed_at"), "a failed upload must be recorded");
  assert.ok(
    /\[field\]: null/.test(route),
    "the photo key must be cleared when its object never arrived",
  );
});

test("discarding a photograph waits for the upload it is discarding", async () => {
  // Deleting the key while the upload is in flight races it: the delete finds
  // nothing, the object lands afterwards, and nothing points at it ever again.
  const { route } = await routeSource("/auto");
  assert.equal(
    route.includes("compensateUploadedPhoto(db, stored.key"),
    false,
    "the refusal paths must not delete a key whose upload has not settled",
  );
  assert.ok(
    /discardPendingUpload = async[\s\S]{0,200}await uploading/.test(route),
    "discarding must await the upload before deleting",
  );
});

test("the photograph is decoded once and reused", async () => {
  // Recognising one encoding and storing another would make a refused or
  // mistaken match impossible to reproduce from the record.
  const { route } = await routeSource("/auto");
  assert.equal(
    (route.match(/normalizeInstructorImage\(/g) || []).length,
    1,
    "the upload must be normalized exactly once",
  );
  const normalize = route.indexOf("normalizeInstructorImage(");
  const search = route.indexOf("searchFaceByImage(normalizedImage.buffer)");
  assert.ok(search > normalize, "the match must run on the normalized bytes");
});

test("a recognised instructor is never held by name", async () => {
  // A hold by name was claimed before the record was written and never
  // released, so a request that failed after taking it left that person unable
  // to retry - and the tablet silent - for the whole window. A repeat capture is
  // answered from the day's record instead.
  const { source, route } = await routeSource("/auto");
  assert.equal(source.includes("instructorCaptureKey"), false, "no hold by instructor may exist");
  assert.ok(
    /if \(instructor\) \{\s*rememberCapture\(tabletKey/.test(route),
    "a recognised frame only starts the tablet hold, and is never refused by it",
  );
});

test("only an unrecognised frame can be refused as a duplicate", async () => {
  const { route } = await routeSource("/auto");
  const claim = route.indexOf("claimCapture(tabletKey, tabletHold)");
  const duplicate = route.indexOf("duplicate: true");
  assert.ok(claim >= 0, "unrecognised frames must take the tablet hold");
  assert.ok(/else if \(!claimCapture\(tabletKey/.test(route), "the claim belongs to the unrecognised branch");
  assert.ok(duplicate > claim, "the duplicate reply follows a refused claim");
  assert.equal(
    route.includes("UNIDENTIFIED_CAPTURE_WINDOW_MS"),
    true,
    "the hold is the short tablet window, not a long one",
  );
});

test("a recognised frame briefly protects the tablet from a trailing NO_FACE frame", async () => {
  const { route } = await routeSource("/auto");
  const matchedTabletGuard = route.indexOf("rememberCapture(tabletKey, tabletHold)");
  const unidentifiedCommit = route.indexOf("commitUnidentifiedCheckIn(");
  assert.ok(matchedTabletGuard >= 0 && matchedTabletGuard < unidentifiedCommit);
});

test("an unrecognised face is recorded as an arrival, never as a departure", async () => {
  // A check-out closes one specific open session; there is no way to tell which
  // one an unidentified photograph belongs to.
  const { route } = await routeSource("/auto");
  const unidentified = route.indexOf("action === KIOSK_ACTIONS.UNIDENTIFIED");
  const commitUnidentified = route.indexOf("commitUnidentifiedCheckIn(");
  assert.ok(unidentified >= 0 && commitUnidentified > unidentified);
  // And it returns before ever reaching the check-out update.
  const checkoutUpdate = route.indexOf("check_out_time: null");
  assert.ok(
    commitUnidentified < checkoutUpdate,
    "the unidentified branch must return before the check-out path",
  );
});

test("the check-out update is guarded so one session cannot be closed twice", async () => {
  // Two photographs taken moments apart would otherwise both close it, and the
  // second would overwrite the first departure time.
  const { route } = await routeSource("/auto");
  assert.ok(
    route.includes("check_out_time: null"),
    "the update must match only a session that is still open",
  );
  assert.ok(
    route.includes("kiosk_duplicate_checkout"),
    "a lost race must discard its photograph rather than orphan it",
  );
});

test("a failed commit discards the photograph it had already stored", async () => {
  // The upload happens before the write, so every path that fails to write has
  // to clean up after itself.
  const { route } = await routeSource("/auto");
  for (const reason of [
    "kiosk_checkin_commit_failed",
    "kiosk_duplicate_checkout",
  ]) {
    assert.ok(route.includes(reason), `${reason} must compensate its stored photo`);
  }
});

test("the check-out half is queued for the worker, like the check-in half", async () => {
  const { route } = await routeSource("/auto");
  assert.ok(route.includes('kind: "checkout"'), "the checkout job must be the checkout half");
  assert.equal(
    route.includes("evaluateCheckoutNow("),
    false,
    "the kiosk must not hold the request open for a vision call",
  );
});

test("the decision matches what the day actually looks like", () => {
  // Wired through the real availability function rather than a fixture, so the
  // route and the decision cannot drift apart.
  const morning = new Date(Date.UTC(2026, 8, 11, 3, 30));   // 09:00 IST
  const beforeNoon = new Date(Date.UTC(2026, 8, 11, 6, 0)); // 11:30 IST
  const afternoon = new Date(Date.UTC(2026, 8, 11, 12, 0)); // 17:30 IST

  const noRecord = decideKioskAction({
    matched: true,
    availability: checkoutAvailability(null, afternoon),
  });
  assert.equal(noRecord, KIOSK_ACTIONS.CHECK_IN);

  const open = { check_in_time: morning, check_out_time: null };
  assert.equal(
    decideKioskAction({ matched: true, availability: checkoutAvailability(open, beforeNoon) }),
    KIOSK_ACTIONS.TOO_EARLY,
  );
  assert.equal(
    decideKioskAction({ matched: true, availability: checkoutAvailability(open, afternoon) }),
    KIOSK_ACTIONS.CHECK_OUT,
  );

  const closed = { check_in_time: morning, check_out_time: afternoon };
  assert.equal(
    decideKioskAction({ matched: true, availability: checkoutAvailability(closed, afternoon) }),
    KIOSK_ACTIONS.ALREADY_DONE,
  );
});

test("an unmatched face is an arrival whatever the day looks like", () => {
  const open = { check_in_time: new Date(Date.UTC(2026, 8, 11, 3, 30)), check_out_time: null };
  const afternoon = new Date(Date.UTC(2026, 8, 11, 12, 0));
  assert.equal(
    decideKioskAction({ matched: false, availability: checkoutAvailability(open, afternoon) }),
    KIOSK_ACTIONS.UNIDENTIFIED,
  );
});
