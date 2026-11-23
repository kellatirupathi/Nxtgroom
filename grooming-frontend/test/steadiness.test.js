import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  anchorFromPose,
  clearToFire,
  createSteadyMemory,
  fastestMovement,
  forgetAnchors,
  isSteady,
  MAX_BODY_SPEED,
  MAX_GROUP_BODY_SPEED,
  recordAnchors,
  STEADY_BASELINE_MS,
  STEADY_WAIT_LIMIT_MS,
} from '../src/lib/steadiness.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const FRAME_HEIGHT = 480;

// Somebody standing in a 360 x 480 picture, head at y 60 and feet at y 440,
// moved sideways by `dx` and down by `dy` pixels.
function person({ dx = 0, dy = 0, id, wobble = 0 } = {}) {
  const at = (name, x, y, score = 0.8) => ({ name, x: x + dx + wobble, y: y + dy - wobble, score });
  return {
    ...(id === undefined ? {} : { id }),
    keypoints: [
      at('nose', 180, 70),
      at('left_eye', 188, 62),
      at('right_eye', 172, 62),
      at('left_shoulder', 215, 130),
      at('right_shoulder', 145, 130),
      at('left_hip', 205, 250),
      at('right_hip', 155, 250),
      at('left_knee', 203, 345),
      at('right_knee', 157, 345),
      at('left_ankle', 201, 440),
      at('right_ankle', 159, 440),
    ],
  };
}

const anchor = (options) => anchorFromPose(person(options), FRAME_HEIGHT);

test('an anchor is the body points that move with a person, measured against their height', () => {
  const found = anchor();
  assert.deepEqual(Object.keys(found.points).sort(), ['left_hip', 'left_shoulder', 'nose', 'right_hip', 'right_shoulder']);
  assert.ok(Math.abs(found.size - (440 - 62) / FRAME_HEIGHT) < 1e-9, 'eyes to ankles');
  assert.deepEqual(found.points.nose, [180 / FRAME_HEIGHT, 70 / FRAME_HEIGHT]);
  assert.equal(anchor({ id: 7 }).id, 7);
  assert.equal(anchorFromPose({ keypoints: [{ name: 'nose', x: 1, y: 1, score: 0.9 }] }, FRAME_HEIGHT), null, 'too little to go by');
  assert.equal(anchorFromPose(person(), 0), null);
  const faint = { keypoints: person().keypoints.map((point) => ({ ...point, score: 0.1 })) };
  assert.equal(anchorFromPose(faint, FRAME_HEIGHT), null, 'guesses are not anchors');
});

test('nothing can be said until there is an earlier reading old enough to compare with', () => {
  const memory = createSteadyMemory();
  assert.equal(fastestMovement(memory, [anchor()], 1_000), null, 'no history');
  recordAnchors(memory, [anchor()], 1_000);
  assert.equal(fastestMovement(memory, [anchor()], 1_000 + STEADY_BASELINE_MS - 1), null, 'too recent');
  assert.equal(isSteady(memory, [anchor()], 1_000 + STEADY_BASELINE_MS - 1), false, 'unknown is not steady');
  assert.equal(fastestMovement(memory, [anchor()], 1_000 + STEADY_BASELINE_MS), 0);
  assert.equal(fastestMovement(memory, [], 2_000), null, 'nobody there');
  assert.equal(fastestMovement(memory, undefined, 2_000), null);
});

test('somebody standing still is steady, even though the detector trembles a little', () => {
  const memory = createSteadyMemory();
  for (let step = 0; step < 12; step += 1) {
    const now = 1_000 + step * 90;
    const current = [anchor({ wobble: step % 2 ? 1.5 : -1.5 })];
    if (step >= 5) {
      const speed = fastestMovement(memory, current, now);
      assert.ok(speed !== null && speed < MAX_BODY_SPEED / 2, `step ${step}: ${speed}`);
      assert.equal(isSteady(memory, current, now), true);
    }
    recordAnchors(memory, current, now);
  }
});

test('somebody still stepping into place is not steady', () => {
  const memory = createSteadyMemory();
  // 40 px every 100 ms is about one body height a second: a slow walk.
  for (let step = 0; step < 8; step += 1) {
    const now = 1_000 + step * 100;
    const current = [anchor({ dx: step * 40, id: 3 })];
    if (step >= 4) {
      const speed = fastestMovement(memory, current, now);
      assert.ok(speed > 0.9 && speed < 1.2, `about one body height a second, got ${speed}`);
      assert.equal(isSteady(memory, current, now), false);
    }
    recordAnchors(memory, current, now);
  }
  // Without tracking, somebody who has walked that far is simply somebody
  // new: nothing is known about them yet, which is not steady either.
  const untracked = createSteadyMemory();
  recordAnchors(untracked, [anchor()], 0);
  assert.equal(fastestMovement(untracked, [anchor({ dx: 160 })], 400), null);
  assert.equal(isSteady(untracked, [anchor({ dx: 160 })], 400), false);
  // Shifting weight: 8 px in 400 ms is 0.05 body heights a second.
  const settled = createSteadyMemory();
  recordAnchors(settled, [anchor()], 0);
  assert.equal(isSteady(settled, [anchor({ dx: 8 })], 400), true);
  // A step back: 60 px in 400 ms.
  assert.equal(isSteady(settled, [anchor({ dy: 60 })], 400), false);
});

test('in a group everybody has to be still, and people are told apart by where they stand', () => {
  const memory = createSteadyMemory();
  recordAnchors(memory, [anchor({ dx: -120 }), anchor({ dx: 0 }), anchor({ dx: 120 })], 0);
  const still = [anchor({ dx: -120 }), anchor({ dx: 0 }), anchor({ dx: 120 })];
  assert.equal(isSteady(memory, still, 400, MAX_GROUP_BODY_SPEED), true);
  const oneMoving = [anchor({ dx: -120 }), anchor({ dx: 0, dy: 50 }), anchor({ dx: 120 })];
  assert.equal(isSteady(memory, oneMoving, 400, MAX_GROUP_BODY_SPEED), false);
  const newcomer = [...still, anchor({ dx: 300 })];
  assert.equal(fastestMovement(memory, newcomer, 400), null, 'somebody who was not there a moment ago');
  assert.equal(isSteady(memory, newcomer, 400, MAX_GROUP_BODY_SPEED), false);
});

test('one look in which the detector missed somebody does not stall the photograph', () => {
  const memory = createSteadyMemory();
  const everybody = () => [anchor({ dx: -120 }), anchor({ dx: 0 }), anchor({ dx: 120 })];
  recordAnchors(memory, everybody(), 0);
  recordAnchors(memory, [anchor({ dx: -120 }), anchor({ dx: 120 })], 300);
  // At 700 ms the newest comparable reading (300 ms) lacks the middle person;
  // the one before it has all three.
  assert.equal(fastestMovement(memory, everybody(), 700), 0);
  assert.equal(isSteady(memory, everybody(), 700, MAX_GROUP_BODY_SPEED), true);
});

test('a tracked person is followed by their id, however the detector lists them', () => {
  const memory = createSteadyMemory();
  recordAnchors(memory, [anchor({ id: 1, dx: -40 }), anchor({ id: 2, dx: 40 })], 0);
  const swapped = [anchor({ id: 2, dx: 40 }), anchor({ id: 1, dx: -40 })];
  assert.equal(fastestMovement(memory, swapped, 400), 0);
});

test('old readings are dropped, and a turned camera starts again from nothing', () => {
  const memory = createSteadyMemory();
  recordAnchors(memory, [anchor()], 0);
  recordAnchors(memory, [anchor()], 5_000);
  assert.equal(memory.samples.length, 1, 'the reading from five seconds ago is gone');
  assert.equal(fastestMovement(memory, [anchor()], 5_100), null, 'only a reading too recent to compare with is left');
  forgetAnchors(memory);
  assert.equal(memory.samples.length, 0);
});

test('a ready photograph waits for people to settle, but never for long', () => {
  const hold = { since: null };
  assert.equal(clearToFire(hold, false, true, 0), false, 'not ready, nothing to fire');
  assert.equal(clearToFire(hold, true, true, 100), true, 'ready and steady fires at once');
  assert.equal(hold.since, null);

  assert.equal(clearToFire(hold, true, false, 1_000), false, 'still moving');
  assert.equal(clearToFire(hold, true, false, 1_000 + STEADY_WAIT_LIMIT_MS - 1), false);
  assert.equal(clearToFire(hold, true, false, 1_000 + STEADY_WAIT_LIMIT_MS), true, 'the wait is over');
  assert.equal(hold.since, null, 'the next photograph gets a fresh wait');

  assert.equal(clearToFire(hold, true, false, 5_000), false);
  assert.equal(clearToFire(hold, false, false, 5_200), false, 'no longer ready');
  assert.equal(clearToFire(hold, true, false, 5_400), false, 'the wait starts again');
  assert.equal(clearToFire(hold, true, true, 5_600), true, 'settled before the limit');
  assert.ok(STEADY_WAIT_LIMIT_MS <= 2_000, 'the wait must stay short');
});

test('both cameras hold a ready photograph for steadiness instead of resetting the count', () => {
  const single = read('src/components/CameraCapture.tsx');
  assert.match(single, /const steady = isSteady\(steadyMemory, reading\.anchors, readAt\);/);
  assert.match(single, /if \(clearToFire\(steadyHold, ready, steady, now\)\) \{\s*void shootRef\.current\(\{ viaAuto: true \}\);/);
  assert.match(single, /const ready = autoCaptureReady\(stableReading\.verdict, held\)\s*&& postureHoldComplete\(postureSinceRef\.current, now\)\s*&& Date\.now\(\) >= cooldownUntilRef\.current\s*&& !firingRef\.current;/);

  const group = read('src/components/GroupCameraCapture.tsx');
  assert.match(group, /const settled = next\.verdict === 'GROUP_READY'\s*&& isSteady\(steadyMemory, next\.anchors, readAt, MAX_GROUP_BODY_SPEED\);/);
  assert.match(group, /const ready = groupCaptureReady\(stable\.verdict, held\)\s*&& Date\.now\(\) >= cooldownUntilRef\.current\s*&& !firingRef\.current;/);
  assert.match(group, /const fire = clearToFire\(steadyHold, ready, settled, Date\.now\(\)\);/);
  assert.match(group, /setSteadyFrames\(ready && !fire \? Math\.min\(held, GROUP_CAPTURE_CONFIRMATIONS - 1\) : held\);/);

  for (const camera of [single, group]) {
    assert.match(camera, /if \(turned\.switched\) \{[\s\S]{0,120}?forgetAnchors\(steadyMemory\);/, 'a turned picture is a new picture');
    const paused = camera.indexOf('if (pausedRef.current) {');
    assert.ok(camera.indexOf('forgetAnchors(steadyMemory);', paused) > paused, 'a paused camera forgets who was there');
  }
});
