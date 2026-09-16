import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  instructorCaptureKey,
  RECENT_CAPTURE_WINDOW_MS,
  rememberCapture,
  resetRecentCaptures,
  tabletCaptureKey,
  UNIDENTIFIED_CAPTURE_WINDOW_MS,
  wasRecentlyCaptured,
} from "../src/services/recentCaptures.js";

/**
 * The kiosk camera fires five times a second, so something has to stop one
 * person being recorded on every frame. That used to be an eight-second
 * cooldown in the browser, which blocked the camera for everybody — a queue
 * moved at one person every nine seconds to solve a problem caused by one
 * person not moving.
 *
 * Remembering who was seen is both faster and stricter: a different face is
 * never delayed, and the same face is refused for the whole window rather than
 * being free again the moment a timer expired.
 */

beforeEach(() => resetRecentCaptures());

test("the same person is refused inside the window", () => {
  const key = instructorCaptureKey("college-1", "instructor-1");
  const now = 1_000_000;

  assert.equal(wasRecentlyCaptured(key, { now }), false, "nobody has been seen yet");
  rememberCapture(key, { now });
  assert.equal(wasRecentlyCaptured(key, { now: now + 1_000 }), true);
  assert.equal(wasRecentlyCaptured(key, { now: now + RECENT_CAPTURE_WINDOW_MS - 1 }), true);
});

test("a different person is never delayed by somebody else's capture", () => {
  // The whole point: a queue must not wait for the person in front of it.
  const first = instructorCaptureKey("college-1", "instructor-1");
  const second = instructorCaptureKey("college-1", "instructor-2");
  const now = 1_000_000;

  rememberCapture(first, { now });
  assert.equal(wasRecentlyCaptured(second, { now: now + 1 }), false);
});

test("the same instructor at a different college is a different subject", () => {
  // College is part of the key because the record is scoped that way too.
  const here = instructorCaptureKey("college-1", "instructor-1");
  const there = instructorCaptureKey("college-2", "instructor-1");
  const now = 1_000_000;

  rememberCapture(here, { now });
  assert.equal(wasRecentlyCaptured(there, { now: now + 1 }), false);
});

test("the window ends, so somebody can check out after checking in", () => {
  // A guard that renewed itself while a person stood there would stop them
  // ever checking out.
  const key = instructorCaptureKey("college-1", "instructor-1");
  const now = 1_000_000;

  rememberCapture(key, { now });
  assert.equal(wasRecentlyCaptured(key, { now: now + RECENT_CAPTURE_WINDOW_MS }), false);
  assert.equal(wasRecentlyCaptured(key, { now: now + RECENT_CAPTURE_WINDOW_MS + 5_000 }), false);
});

test("reading does not extend the window", () => {
  // Somebody standing in front of the camera for a full minute is reconsidered
  // when their window ends, rather than being locked out for as long as they
  // keep standing there.
  const key = instructorCaptureKey("college-1", "instructor-1");
  const now = 1_000_000;

  rememberCapture(key, { now });
  for (let at = now; at < now + RECENT_CAPTURE_WINDOW_MS; at += 200) {
    wasRecentlyCaptured(key, { now: at });
  }
  assert.equal(wasRecentlyCaptured(key, { now: now + RECENT_CAPTURE_WINDOW_MS }), false);
});

test("an unidentified capture is held per tablet, and only briefly", () => {
  // There is no name to remember, so the tablet itself is the subject. Short,
  // because this blocks a real person from trying again.
  const key = tabletCaptureKey("boa@example.com");
  const now = 1_000_000;

  rememberCapture(key, { now, windowMs: UNIDENTIFIED_CAPTURE_WINDOW_MS });
  assert.equal(wasRecentlyCaptured(key, { now: now + 1_000 }), true);
  assert.equal(wasRecentlyCaptured(key, { now: now + UNIDENTIFIED_CAPTURE_WINDOW_MS }), false);
  assert.ok(
    UNIDENTIFIED_CAPTURE_WINDOW_MS < RECENT_CAPTURE_WINDOW_MS,
    "a retake must not wait as long as a duplicate",
  );
});

test("two tablets do not share an unidentified window", () => {
  const here = tabletCaptureKey("boa-a@example.com");
  const there = tabletCaptureKey("boa-b@example.com");
  const now = 1_000_000;

  rememberCapture(here, { now, windowMs: UNIDENTIFIED_CAPTURE_WINDOW_MS });
  assert.equal(wasRecentlyCaptured(there, { now: now + 1 }), false);
});

test("an empty key is never treated as seen", () => {
  // A missing college or email must not collapse every subject onto one key.
  assert.equal(wasRecentlyCaptured("", { now: 1 }), false);
  rememberCapture("", { now: 1 });
  assert.equal(wasRecentlyCaptured("", { now: 2 }), false);
});

test("the windows are the durations the design settled on", () => {
  // Long enough to cover somebody lingering after their photograph was taken.
  assert.ok(RECENT_CAPTURE_WINDOW_MS >= 30_000 && RECENT_CAPTURE_WINDOW_MS <= 90_000);
  // Short enough that an unrecognised person can retake almost at once.
  assert.ok(UNIDENTIFIED_CAPTURE_WINDOW_MS >= 1_000 && UNIDENTIFIED_CAPTURE_WINDOW_MS <= 5_000);
});
