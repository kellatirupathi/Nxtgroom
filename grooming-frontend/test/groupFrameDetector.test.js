import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distinctPeople,
  faceIsVisible,
  GROUP_CAPTURE_CONFIRMATIONS,
  GROUP_MAX_PEOPLE,
  groupCaptureReady,
  groupFallbackDue,
  groupShutterEnabled,
  INITIAL_GROUP_STATE,
  readGroupPoses,
  stabilizeGroupReading,
} from '../src/lib/groupFrameDetector.ts';
import { readPoses } from '../src/lib/fullBodyDetector.ts';

function person(x, { face = true } = {}) {
  const head = face
    ? [
      { name: 'nose', score: 0.9, x, y: 80 },
      { name: 'left_eye', score: 0.9, x: x - 6, y: 75 },
      { name: 'right_eye', score: 0.9, x: x + 6, y: 75 },
    ]
    : [{ name: 'nose', score: 0.1, x, y: 80 }];
  return {
    keypoints: [
      ...head,
      { name: 'left_shoulder', score: 0.9, x: x - 20, y: 180 },
      { name: 'right_shoulder', score: 0.9, x: x + 20, y: 180 },
      { name: 'left_hip', score: 0.9, x: x - 15, y: 430 },
      { name: 'right_hip', score: 0.9, x: x + 15, y: 430 },
      { name: 'left_knee', score: 0.9, x: x - 12, y: 630 },
      { name: 'right_knee', score: 0.9, x: x + 12, y: 630 },
      { name: 'left_ankle', score: 0.8, x: x - 10, y: 820 },
      { name: 'right_ankle', score: 0.8, x: x + 10, y: 820 },
    ],
  };
}

const line = (count, options) => Array.from(
  { length: count },
  (_unused, index) => person(100 + index * 160, options),
);

test('a group the single-person gate refuses is one this gate accepts', () => {
  const four = line(4);
  assert.equal(readPoses(four, 1000, 900).verdict, 'MULTIPLE_PEOPLE');
  assert.equal(readGroupPoses(four, 1000).verdict, 'GROUP_READY');
});

test('the camera fires only once the group has held still', () => {
  const reading = readGroupPoses(line(3), 1000);
  assert.equal(reading.verdict, 'GROUP_READY');
  assert.equal(reading.guidance, null, 'a correct frame needs no commentary');

  assert.equal(groupCaptureReady('GROUP_READY', GROUP_CAPTURE_CONFIRMATIONS - 1), false);
  assert.equal(groupCaptureReady('GROUP_READY', GROUP_CAPTURE_CONFIRMATIONS), true);
  for (const verdict of ['FACES_HIDDEN', 'TOO_FEW', 'TOO_MANY', 'NO_PEOPLE', 'UNAVAILABLE']) {
    assert.equal(groupCaptureReady(verdict, 99), false, `${verdict} must not fire automatically`);
  }
});

test('somebody facing away is named, and the camera waits', () => {
  const mixed = [person(100), person(260), person(420, { face: false })];
  const reading = readGroupPoses(mixed, 1000);

  assert.equal(reading.verdict, 'FACES_HIDDEN');
  assert.equal(reading.people, 3);
  assert.equal(reading.faces, 2);
  assert.match(reading.guidance, /one person is not facing/i);

  const twoAway = [person(100), person(260, { face: false }), person(420, { face: false })];
  assert.match(readGroupPoses(twoAway, 1000).guidance, /2 people are not facing/i);
});

test('one person is sent to the screen built for one person', () => {
  const alone = readGroupPoses(line(1), 1000);
  assert.equal(alone.verdict, 'TOO_FEW');
  assert.match(alone.guidance, /single check-in/i);
});

test('an empty frame asks people to step in', () => {
  for (const poses of [undefined, [], [{ keypoints: [] }]]) {
    const reading = readGroupPoses(poses, 1000);
    assert.equal(reading.verdict, 'NO_PEOPLE');
    assert.equal(reading.people, 0);
  }
});

test('more people than one request may record is refused at the camera', () => {
  const crowd = readGroupPoses(line(GROUP_MAX_PEOPLE + 1), 1000);
  assert.equal(crowd.verdict, 'TOO_MANY');
  assert.equal(crowd.people, GROUP_MAX_PEOPLE + 1);
  assert.match(crowd.guidance, new RegExp(`${GROUP_MAX_PEOPLE} at a time`));

  assert.equal(readGroupPoses(line(GROUP_MAX_PEOPLE), 1000).verdict, 'GROUP_READY');
});

test('the manual shutter stays open for frames auto-capture will not fire on', () => {
  assert.equal(groupShutterEnabled('GROUP_READY'), true);
  assert.equal(groupShutterEnabled('FACES_HIDDEN'), true);
  assert.equal(groupShutterEnabled('TOO_FEW'), true);
  assert.equal(groupShutterEnabled('UNAVAILABLE'), true, 'a failed detector must not block attendance');
  assert.equal(groupShutterEnabled('NO_PEOPLE'), false);
  assert.equal(groupShutterEnabled('TOO_MANY'), false);
});

test('the button is offered before a struggling group has given up', () => {
  assert.equal(groupFallbackDue(0), false);
  assert.equal(groupFallbackDue(14), false);
  assert.equal(groupFallbackDue(15), true);
  assert.ok(15 / 5 <= 5, 'the fallback must arrive within a few seconds');
});

test('overlapping copies of one person are not counted as a group', () => {
  const one = person(300);
  const ghost = { keypoints: one.keypoints.map((k) => ({ ...k, score: 0.5, x: k.x + 3 })) };

  assert.equal(distinctPeople([one, ghost], 1000).length, 1);
  assert.equal(readGroupPoses([one, ghost], 1000).verdict, 'TOO_FEW');
});

test('a face needs two landmarks, not one', () => {
  assert.equal(faceIsVisible(person(100)), true);
  assert.equal(faceIsVisible({
    keypoints: [{ name: 'nose', score: 0.9, x: 10, y: 10 }],
  }), false);
  assert.equal(faceIsVisible({ keypoints: [] }), false);
});

test('the screen does not flicker on one noisy reading', () => {
  let state = INITIAL_GROUP_STATE;
  const ready = readGroupPoses(line(3), 1000);
  const empty = readGroupPoses([], 1000);

  state = stabilizeGroupReading(state, ready);
  state = stabilizeGroupReading(state, ready);
  state = stabilizeGroupReading(state, ready);
  assert.equal(state.reading.verdict, 'GROUP_READY');

  state = stabilizeGroupReading(state, empty);
  assert.equal(state.reading.verdict, 'GROUP_READY', 'one bad reading changed the verdict');

  state = stabilizeGroupReading(state, empty);
  state = stabilizeGroupReading(state, empty);
  assert.equal(state.reading.verdict, 'NO_PEOPLE', 'a sustained change must get through');
});

test('a group whose count wobbles keeps its hold', () => {
  let state = { ...INITIAL_GROUP_STATE };
  state = stabilizeGroupReading(state, readGroupPoses(line(4), 1000));
  state = stabilizeGroupReading(state, readGroupPoses(line(4), 1000));
  state = stabilizeGroupReading(state, readGroupPoses(line(3), 1000));

  assert.equal(state.reading.verdict, 'GROUP_READY');
  assert.equal(state.candidateCount, 0, 'the verdict agreed, so nothing is pending');
});

import { boxLabel } from '../src/lib/groupFrameDetector.ts';

const cutAtKnees = (x) => ({
  keypoints: person(x).keypoints.map((point) => (
    point.name.endsWith('_ankle') ? { ...point, y: 660, score: 0.6 } : point
  )),
});

test('one person half in frame stops the whole group being photographed', () => {
  const reading = readGroupPoses([person(100), person(260), cutAtKnees(420)], 1000);
  assert.equal(reading.verdict, 'BODIES_CUT');
  assert.equal(reading.people, 3, 'they are still counted; they are just not ready');
  assert.match(reading.guidance, /one person is not fully in frame/i);
  assert.match(reading.guidance, /step back/i);
  assert.equal(groupCaptureReady('BODIES_CUT', 99), false, 'must never fire by itself');
  assert.equal(groupShutterEnabled('BODIES_CUT'), true, 'but a person may still judge the frame');

  const two = readGroupPoses([person(100), cutAtKnees(260), cutAtKnees(420)], 1000);
  assert.match(two.guidance, /2 people are not fully in frame/i);
});

test('somebody turned away is told to face the camera, not that they are cut off', () => {
  const reading = readGroupPoses([person(100), person(260, { face: false })], 1000);
  assert.equal(reading.verdict, 'FACES_HIDDEN');
  assert.match(reading.guidance, /not facing the camera/i);
});

test('the chip under each box says what that person, specifically, must fix', () => {
  assert.equal(boxLabel(person(100), 1000), null, 'nothing to fix, nothing to say');
  assert.equal(boxLabel(cutAtKnees(100), 1000), 'Step back');
  assert.equal(boxLabel(person(100, { face: false }), 1000), 'Face the camera');
  const both = { keypoints: cutAtKnees(100).keypoints.map((point) => (
    point.name === 'nose' || point.name.endsWith('_eye') ? { ...point, score: 0.1 } : point
  )) };
  assert.equal(boxLabel(both, 1000), 'Face the camera');
});

test('a whole group standing properly is still photographed', () => {
  assert.equal(readGroupPoses(line(4), 1000).verdict, 'GROUP_READY');
  assert.equal(readGroupPoses(line(GROUP_MAX_PEOPLE), 1000).verdict, 'GROUP_READY');
});

import { groupBoxes } from '../src/lib/groupFrameDetector.ts';

test('a ghost copy of somebody gets no box and no chip', () => {
  const a = person(100);
  const ghost = {
    keypoints: a.keypoints
      .filter((k) => ['nose', 'left_eye', 'right_eye', 'left_shoulder', 'right_shoulder'].includes(k.name))
      .map((k) => ({ ...k, score: 0.5, x: k.x + 2 })),
  };
  const boxes = groupBoxes([a, person(300), ghost], { frameWidth: 480, frameHeight: 1000 });
  assert.equal(boxes.length, 2, 'one box per counted person');
  assert.ok(boxes.every((box) => !('label' in box)), 'nobody counted has anything to fix');
  assert.equal(readGroupPoses([a, person(300), ghost], 1000).verdict, 'GROUP_READY');
});
