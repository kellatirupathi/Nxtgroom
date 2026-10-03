import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { checkoutAvailability } from "../src/routes/attendanceRoutes.js";
import { decideKioskAction, KIOSK_ACTIONS } from "../src/services/kioskAction.js";

async function routeSource(path) {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  const name = source.indexOf(`"${path}"`);
  const start = source.lastIndexOf("attendanceRouter.post(", name);
  const after = source.indexOf("attendanceRouter.post(", name);
  return { source, route: source.slice(start, after > start ? after : undefined) };
}

test("/auto is registered before any parameterised route", async () => {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");

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
  const { route } = await routeSource("/auto");
  const refusal = route.indexOf("KIOSK_ACTIONS.TOO_EARLY || action === KIOSK_ACTIONS.ALREADY_DONE");
  const store = route.indexOf("uploadPhoto(");
  assert.ok(refusal >= 0, "the route must handle the outcomes that record nothing");
  assert.ok(store > refusal, "nothing may be stored before those outcomes have returned");
});

test("the tablet is not made to wait for the upload", async () => {
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
  const { route } = await routeSource("/auto");
  for (const [label, offset] of [["check-in", 0], ["check-out", 1]]) {
    const settle = route.indexOf("settleUpload(", offset === 0 ? 0 : route.indexOf("KIOSK_ACTIONS.CHECK_IN"));
    assert.ok(settle >= 0, `${label} must settle the upload`);
  }
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
  const { route } = await routeSource("/auto");
  assert.ok(route.includes("photo_storage_failed_at"), "a failed upload must be recorded");
  assert.ok(
    /\[field\]: null/.test(route),
    "the photo key must be cleared when its object never arrived",
  );
});

test("discarding a photograph waits for the upload it is discarding", async () => {
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
    route.includes("CAPTURE_WINDOW_MS"),
    true,
    "the hold is the short tablet window, not a long one",
  );
});

test("a recognised frame briefly protects the tablet from a trailing NO_FACE frame", async () => {
  const { route } = await routeSource("/auto");
  const matchedTabletGuard = route.indexOf("rememberCapture(tabletKey, tabletHold)");
  const unknownReply = route.indexOf("action === KIOSK_ACTIONS.NOT_RECOGNISED");
  assert.ok(matchedTabletGuard >= 0 && matchedTabletGuard < unknownReply);
});

test("an unrecognised face is rejected before storage or attendance writes", async () => {
  const { route } = await routeSource("/auto");
  const refusal = route.indexOf("action === KIOSK_ACTIONS.NOT_RECOGNISED");
  const upload = route.indexOf("const uploading = uploadPhoto(");
  assert.ok(refusal >= 0 && refusal < upload);
  assert.equal(route.includes("commitUnidentifiedCheckIn("), false);
  assert.match(route.slice(refusal, upload), /recorded: false/);
});

test("the check-out update is guarded so one session cannot be closed twice", async () => {
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
  const morning = new Date(Date.UTC(2026, 8, 11, 3, 30));
  const beforeNoon = new Date(Date.UTC(2026, 8, 11, 6, 0));
  const afternoon = new Date(Date.UTC(2026, 8, 11, 12, 0));

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

test("an unmatched face is rejected whatever the day looks like", () => {
  const open = { check_in_time: new Date(Date.UTC(2026, 8, 11, 3, 30)), check_out_time: null };
  const afternoon = new Date(Date.UTC(2026, 8, 11, 12, 0));
  assert.equal(
    decideKioskAction({ matched: false, availability: checkoutAvailability(open, afternoon) }),
    KIOSK_ACTIONS.NOT_RECOGNISED,
  );
});
