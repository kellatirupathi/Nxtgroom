import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERRIDE_AFTER_MS,
  readKeypoints,
  shutterEnabled,
  STEADY_MS,
} from '../src/lib/fullBodyDetector.ts';

const point = (name, score) => ({ name, score });
const wholePerson = [point('nose', 0.9), point('left_ankle', 0.8), point('right_ankle', 0.8)];

/**
 * The gate exists because a head-and-shoulders photograph leaves eleven of
 * twenty checkpoints unassessable. It must never become a reason somebody
 * cannot check in, so every failure path opens the shutter rather than closing
 * it.
 */

test('a whole person is head and both ankles, nothing else', () => {
  assert.equal(readKeypoints(wholePerson).verdict, 'FULL_BODY');
  assert.equal(readKeypoints(wholePerson).guidance, null, 'a correct frame needs no commentary');
});

test('one ankle is not a full-body photograph', () => {
  // Someone standing at an angle, or with one foot just out of frame, has not
  // given the report anything to judge their footwear by.
  const oneFoot = [point('nose', 0.9), point('left_ankle', 0.8), point('right_ankle', 0.05)];
  assert.equal(readKeypoints(oneFoot).verdict, 'PARTIAL');
  assert.match(readKeypoints(oneFoot).guidance, /step back/i);
});

test('a low-confidence keypoint is a guess, not a sighting', () => {
  const uncertain = [point('nose', 0.9), point('left_ankle', 0.2), point('right_ankle', 0.2)];
  assert.equal(readKeypoints(uncertain).verdict, 'PARTIAL');
});

test('the instruction names what to change', () => {
  // "Step back" and "move the camera down" are opposite corrections, and
  // giving the wrong one sends somebody further from a usable photograph.
  const feetOnly = [point('left_ankle', 0.8), point('right_ankle', 0.8)];
  assert.match(readKeypoints(feetOnly).guidance, /head is out of frame/i);

  const headOnly = [point('nose', 0.9)];
  assert.match(readKeypoints(headOnly).guidance, /feet are not in frame/i);
});

test('an empty frame asks the person to step into it', () => {
  assert.equal(readKeypoints([]).verdict, 'NO_PERSON');
  assert.equal(readKeypoints(undefined).verdict, 'NO_PERSON');
  assert.match(readKeypoints([]).guidance, /step into the frame/i);
});

test('the shutter waits for a frame that holds', () => {
  // A single lucky frame while somebody is still walking backwards is not a
  // steady full-body shot, and capturing on it defeats the gate.
  assert.equal(shutterEnabled('FULL_BODY', 0, false), false);
  assert.equal(shutterEnabled('FULL_BODY', STEADY_MS - 1, false), false);
  assert.equal(shutterEnabled('FULL_BODY', STEADY_MS, false), true);
});

test('a partial frame keeps the shutter shut', () => {
  assert.equal(shutterEnabled('PARTIAL', 10_000, false), false);
  assert.equal(shutterEnabled('NO_PERSON', 10_000, false), false);
});

test('the shutter opens when the detector cannot run at all', () => {
  // No WebGL, a blocked download, an unsupported device. None of those is the
  // instructor's fault, and none may stop them checking in.
  assert.equal(shutterEnabled('UNAVAILABLE', 0, false), true);
});

test('the override opens the shutter whatever the frame shows', () => {
  // A saree hiding the ankles, a wheelchair, a room too small to step back in.
  // Across six hundred daily check-ins even a small miss rate is people who
  // cannot record attendance at all.
  assert.equal(shutterEnabled('PARTIAL', 0, true), true);
  assert.equal(shutterEnabled('NO_PERSON', 0, true), true);
  // And it is offered soon enough to be a way out, not a punishment.
  assert.ok(OVERRIDE_AFTER_MS <= 20_000, 'nobody should be stuck for longer than this');
});
