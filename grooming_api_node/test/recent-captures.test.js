import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import * as recentCaptures from "../src/services/recentCaptures.js";

const {
  claimCapture,
  rememberCapture,
  resetRecentCaptures,
  tabletCaptureKey,
  UNIDENTIFIED_CAPTURE_WINDOW_MS,
  wasRecentlyCaptured,
} = recentCaptures;

/**
 * The only hold left is a short one per tablet, for photographs nobody can be
 * recognised from. A recognised person is answered from their day's record
 * instead, so there is nothing to hold them by.
 */

beforeEach(() => resetRecentCaptures());

test("there is no hold by instructor any more", () => {
  // A 45-second hold by name was claimed before the record was written and
  // never released on failure, so one failed request silenced that person's
  // retries for the whole window.
  assert.equal("instructorCaptureKey" in recentCaptures, false);
  assert.equal("RECENT_CAPTURE_WINDOW_MS" in recentCaptures, false);
});

test("a tablet is held for a few seconds, then free", () => {
  const key = tabletCaptureKey("boa@example.com");
  const now = 1_000_000;

  assert.equal(wasRecentlyCaptured(key, { now }), false);
  rememberCapture(key, { now });
  assert.equal(wasRecentlyCaptured(key, { now: now + 1_000 }), true);
  assert.equal(wasRecentlyCaptured(key, { now: now + UNIDENTIFIED_CAPTURE_WINDOW_MS }), false);
});

test("claiming is an atomic check-and-set for overlapping requests", () => {
  const key = tabletCaptureKey("boa@example.com");
  const now = 1_000_000;

  assert.equal(claimCapture(key, { now }), true);
  assert.equal(claimCapture(key, { now }), false);
  assert.equal(claimCapture(key, { now: now + UNIDENTIFIED_CAPTURE_WINDOW_MS }), true);
});

test("reading does not extend the hold", () => {
  const key = tabletCaptureKey("boa@example.com");
  const now = 1_000_000;

  rememberCapture(key, { now });
  for (let at = now; at < now + UNIDENTIFIED_CAPTURE_WINDOW_MS; at += 200) {
    wasRecentlyCaptured(key, { now: at });
  }
  assert.equal(wasRecentlyCaptured(key, { now: now + UNIDENTIFIED_CAPTURE_WINDOW_MS }), false);
});

test("two tablets do not share a hold", () => {
  const here = tabletCaptureKey("boa-a@example.com");
  const there = tabletCaptureKey("boa-b@example.com");
  const now = 1_000_000;

  rememberCapture(here, { now });
  assert.equal(wasRecentlyCaptured(there, { now: now + 1 }), false);
});

test("an empty key is never treated as held", () => {
  assert.equal(wasRecentlyCaptured("", { now: 1 }), false);
  rememberCapture("", { now: 1 });
  assert.equal(wasRecentlyCaptured("", { now: 2 }), false);
  assert.equal(claimCapture("", { now: 3 }), false);
});

test("the hold is a few seconds, not a queue", () => {
  // Short enough that a failed request is retryable almost at once.
  assert.ok(UNIDENTIFIED_CAPTURE_WINDOW_MS >= 1_000 && UNIDENTIFIED_CAPTURE_WINDOW_MS <= 5_000);
});
