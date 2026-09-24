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

/**
 * The gate for photographing several people at once.
 *
 * It exists because the single-person gate answers this situation with a
 * refusal — MULTIPLE_PEOPLE — and because every rule that gate applies is the
 * wrong rule here: nobody in a group of six fills the outline, and most of
 * everybody's legs are behind somebody else.
 *
 * What it must insist on is faces, because a face is the only thing anybody can
 * be identified from. What it must not do is refuse a frame a person has looked
 * at and judged acceptable: a camera that never fires leaves a queue standing in
 * front of a screen telling them to move, which is worse than a photograph that
 * records five of six people and says so.
 */

/** One person, standing where the detector can see them. */
function person(x, { face = true } = {}) {
  const head = face
    ? [
      { name: 'nose', score: 0.9, x, y: 80 },
      { name: 'left_eye', score: 0.9, x: x - 6, y: 75 },
      { name: 'right_eye', score: 0.9, x: x + 6, y: 75 },
    ]
    // Turned away: the body is plainly there, the face is not.
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
  // The two gates are asked the same question about the same frame and must
  // disagree, which is the entire reason there are two of them.
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
  // No other verdict fires by itself, however long it is held.
  for (const verdict of ['FACES_HIDDEN', 'TOO_FEW', 'TOO_MANY', 'NO_PEOPLE', 'UNAVAILABLE']) {
    assert.equal(groupCaptureReady(verdict, 99), false, `${verdict} must not fire automatically`);
  }
});

test('somebody facing away is named, and the camera waits', () => {
  // They would be photographed, found by the detector, and then not identified
  // by Rekognition — an unidentified record for somebody who was standing right
  // there. Better to say so while they can still turn around.
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
  // The server refuses this too, and its refusal is the one that counts. Saying
  // it here means people can rearrange themselves before a round trip rather
  // than after one.
  const crowd = readGroupPoses(line(GROUP_MAX_PEOPLE + 1), 1000);
  assert.equal(crowd.verdict, 'TOO_MANY');
  assert.equal(crowd.people, GROUP_MAX_PEOPLE + 1);
  assert.match(crowd.guidance, new RegExp(`${GROUP_MAX_PEOPLE} at a time`));

  // Exactly the cap is fine.
  assert.equal(readGroupPoses(line(GROUP_MAX_PEOPLE), 1000).verdict, 'GROUP_READY');
});

test('the manual shutter stays open for frames auto-capture will not fire on', () => {
  // Somebody pressing the button has looked at the frame and decided it is
  // acceptable, and the server reports per person what it could do with the
  // photograph. Only an empty frame and an oversized group stay blocked.
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
  // At five readings a second this is about three seconds, which is sooner than
  // the single-person screen offers it — group framing has more ways to be
  // imperfect and somebody is always looking the wrong way.
  assert.ok(15 / 5 <= 5, 'the fallback must arrive within a few seconds');
});

test('overlapping copies of one person are not counted as a group', () => {
  // MoveNet emits a second, weaker pose over the same body often enough that
  // counting raw poses would photograph one person as a crowd.
  const one = person(300);
  const ghost = { keypoints: one.keypoints.map((k) => ({ ...k, score: 0.5, x: k.x + 3 })) };

  assert.equal(distinctPeople([one, ghost], 1000).length, 1);
  assert.equal(readGroupPoses([one, ghost], 1000).verdict, 'TOO_FEW');
});

test('a face needs two landmarks, not one', () => {
  // A single nose point is as likely to be a profile or the back of a head,
  // which cannot be matched against a reference photograph taken face-on.
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

  // One dropped frame must not blank the screen.
  state = stabilizeGroupReading(state, empty);
  assert.equal(state.reading.verdict, 'GROUP_READY', 'one bad reading changed the verdict');

  state = stabilizeGroupReading(state, empty);
  state = stabilizeGroupReading(state, empty);
  assert.equal(state.reading.verdict, 'NO_PEOPLE', 'a sustained change must get through');
});

test('a group whose count wobbles keeps its hold', () => {
  // Four people momentarily read as three is still GROUP_READY, and resetting
  // the hold on every recount would mean the camera never reached the
  // confirmations it needs.
  let state = { ...INITIAL_GROUP_STATE };
  state = stabilizeGroupReading(state, readGroupPoses(line(4), 1000));
  state = stabilizeGroupReading(state, readGroupPoses(line(4), 1000));
  state = stabilizeGroupReading(state, readGroupPoses(line(3), 1000));

  assert.equal(state.reading.verdict, 'GROUP_READY');
  assert.equal(state.candidateCount, 0, 'the verdict agreed, so nothing is pending');
});

/**
 * A group is photographed only when everybody is in frame head to feet.
 *
 * The same rule the single-person camera applies, and for the same reason: a
 * person cut off at the waist gets a report with nothing to say about their
 * trousers or shoes. Six of those are six reports to redo.
 */
import { boxLabel } from '../src/lib/groupFrameDetector.ts';

/** One person whose legs end at the knee: the model still invents ankles. */
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
  // A hidden face has no visible eyes, which the body check would otherwise
  // read as a missing head. Faces are checked first so the message is the
  // right one.
  const reading = readGroupPoses([person(100), person(260, { face: false })], 1000);
  assert.equal(reading.verdict, 'FACES_HIDDEN');
  assert.match(reading.guidance, /not facing the camera/i);
});

test('the chip under each box says what that person, specifically, must fix', () => {
  assert.equal(boxLabel(person(100), 1000), null, 'nothing to fix, nothing to say');
  assert.equal(boxLabel(cutAtKnees(100), 1000), 'Step back');
  assert.equal(boxLabel(person(100, { face: false }), 1000), 'Face the camera');
  // Turned away and cut off: the face comes first, because without one there
  // is nobody to identify whatever the legs are doing.
  const both = { keypoints: cutAtKnees(100).keypoints.map((point) => (
    point.name === 'nose' || point.name.endsWith('_eye') ? { ...point, score: 0.1 } : point
  )) };
  assert.equal(boxLabel(both, 1000), 'Face the camera');
});

test('a whole group standing properly is still photographed', () => {
  // The rule must not have become one no real group can satisfy.
  assert.equal(readGroupPoses(line(4), 1000).verdict, 'GROUP_READY');
  assert.equal(readGroupPoses(line(GROUP_MAX_PEOPLE), 1000).verdict, 'GROUP_READY');
});

import { groupBoxes } from '../src/lib/groupFrameDetector.ts';

test('a ghost copy of somebody gets no box and no chip', () => {
  // MoveNet emits a sparse duplicate over person A. The gate discards it; a
  // box on it would carry "Step back" under a person the countdown is already
  // running for. Boxes and verdict must come from one list of people.
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
