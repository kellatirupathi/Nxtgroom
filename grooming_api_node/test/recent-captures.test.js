import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import * as recentCaptures from "../src/services/recentCaptures.js";

const {
  claimCapture,
  rememberCapture,
  resetRecentCaptures,
  tabletCaptureKey,
  CAPTURE_WINDOW_MS,
  wasRecentlyCaptured,
} = recentCaptures;

beforeEach(() => resetRecentCaptures());

test("there is no hold by instructor any more", () => {
  assert.equal("instructorCaptureKey" in recentCaptures, false);
  assert.equal("RECENT_CAPTURE_WINDOW_MS" in recentCaptures, false);
});

test("a tablet is held for a few seconds, then free", () => {
  const key = tabletCaptureKey("boa@example.com");
  const now = 1_000_000;

  assert.equal(wasRecentlyCaptured(key, { now }), false);
  rememberCapture(key, { now });
  assert.equal(wasRecentlyCaptured(key, { now: now + 1_000 }), true);
  assert.equal(wasRecentlyCaptured(key, { now: now + CAPTURE_WINDOW_MS }), false);
});

test("claiming is an atomic check-and-set for overlapping requests", () => {
  const key = tabletCaptureKey("boa@example.com");
  const now = 1_000_000;

  assert.equal(claimCapture(key, { now }), true);
  assert.equal(claimCapture(key, { now }), false);
  assert.equal(claimCapture(key, { now: now + CAPTURE_WINDOW_MS }), true);
});

test("reading does not extend the hold", () => {
  const key = tabletCaptureKey("boa@example.com");
  const now = 1_000_000;

  rememberCapture(key, { now });
  for (let at = now; at < now + CAPTURE_WINDOW_MS; at += 200) {
    wasRecentlyCaptured(key, { now: at });
  }
  assert.equal(wasRecentlyCaptured(key, { now: now + CAPTURE_WINDOW_MS }), false);
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
  assert.ok(CAPTURE_WINDOW_MS >= 1_000 && CAPTURE_WINDOW_MS <= 5_000);
});
