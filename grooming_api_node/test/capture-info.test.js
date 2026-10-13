import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCaptureInfo } from "../src/services/captureInfo.js";

test("the tablet's camera report is kept to known fields and a bounded size", () => {
  const info = parseCaptureInfo(JSON.stringify({
    source: "video",
    video: "1080x1920",
    region: "960x1193",
    output: "960x1193",
    bytes: 312000,
    device: "Android: SM-X200",
    still: { outcome: "no-match", capabilities: "2592x1944", raw: "1944x2592", score: 0.41, rotation: 90, extra: "dropped" },
    camera: { width: 1080, height: 1920, frameRate: 30, facingMode: "user", focusMode: "continuous", deviceId: "dropped" },
    password: "dropped",
  }));
  assert.deepEqual(info, {
    source: "video",
    video: "1080x1920",
    region: "960x1193",
    output: "960x1193",
    bytes: 312000,
    device: "Android: SM-X200",
    still: { outcome: "no-match", capabilities: "2592x1944", raw: "1944x2592", score: 0.41, rotation: 90 },
    camera: { width: 1080, height: 1920, frameRate: 30, facingMode: "user", focusMode: "continuous" },
  });
});

test("a missing, oversized or malformed camera report is ignored", () => {
  assert.equal(parseCaptureInfo(undefined), null);
  assert.equal(parseCaptureInfo(""), null);
  assert.equal(parseCaptureInfo("not json"), null);
  assert.equal(parseCaptureInfo("[1,2]"), null);
  assert.equal(parseCaptureInfo(JSON.stringify({ source: "x".repeat(2000) })), null);
  assert.equal(parseCaptureInfo(JSON.stringify({ unknown: 1 })), null);
});
