import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANKLE_CONFIDENCE,
  assessBody,
  describeBodyProblem,
  FEET_BOTTOM_MARGIN,
  shortBodyProblem,
} from '../src/lib/bodyCompleteness.ts';

const FRAME = 1000;

function standing({ ankleY = 820, ankleScore = 0.8, eyeY = 75 } = {}) {
  return [
    { name: 'nose', score: 0.9, x: 100, y: eyeY + 5 },
    { name: 'left_eye', score: 0.9, x: 94, y: eyeY },
    { name: 'right_eye', score: 0.9, x: 106, y: eyeY },
    { name: 'left_shoulder', score: 0.9, x: 80, y: 180 },
    { name: 'right_shoulder', score: 0.9, x: 120, y: 180 },
    { name: 'left_hip', score: 0.9, x: 85, y: 430 },
    { name: 'right_hip', score: 0.9, x: 115, y: 430 },
    { name: 'left_knee', score: 0.9, x: 88, y: 630 },
    { name: 'right_knee', score: 0.9, x: 112, y: 630 },
    { name: 'left_ankle', score: ankleScore, x: 90, y: ankleY },
    { name: 'right_ankle', score: ankleScore, x: 110, y: ankleY },
  ];
}

const without = (keypoints, ...names) => keypoints.filter((point) => !names.includes(point.name));

test('a whole standing person is complete', () => {
  assert.deepEqual(assessBody(standing(), { frameHeight: FRAME }), { complete: true, problem: null });
  assert.equal(assessBody(standing()).complete, true);
});

test('ankles invented just below the knees are not feet', () => {
  const cutAtKnees = standing({ ankleY: 660, ankleScore: 0.6 });
  assert.deepEqual(assessBody(cutAtKnees, { frameHeight: FRAME }), { complete: false, problem: 'FEET' });
  assert.equal(assessBody(cutAtKnees).problem, 'FEET');
});

test('ankles pushed to the bottom edge are not feet', () => {
  const edge = standing({ ankleY: FRAME * (1 - FEET_BOTTOM_MARGIN) + 5, ankleScore: 0.7 });
  assert.equal(assessBody(edge, { frameHeight: FRAME }).problem, 'FEET');
  const inside = standing({ ankleY: FRAME * (1 - FEET_BOTTOM_MARGIN) - 5, ankleScore: 0.7 });
  assert.equal(assessBody(inside, { frameHeight: FRAME }).complete, true);
});

test('an ankle below the stricter confidence floor is not a foot', () => {
  const uncertain = standing({ ankleScore: ANKLE_CONFIDENCE - 0.05 });
  assert.equal(assessBody(uncertain, { frameHeight: FRAME, minScore: 0.35 }).problem, 'FEET');
  const certain = standing({ ankleScore: ANKLE_CONFIDENCE });
  assert.equal(assessBody(certain, { frameHeight: FRAME, minScore: 0.35 }).complete, true);
});

test('one missing foot is enough to refuse', () => {
  assert.equal(assessBody(without(standing(), 'right_ankle'), { frameHeight: FRAME }).problem, 'FEET');
});

test('a head pressed against the top of the frame is cut off', () => {
  assert.equal(assessBody(standing({ eyeY: 10 }), { frameHeight: FRAME }).problem, 'HEAD');
  assert.equal(assessBody(without(standing(), 'left_eye', 'right_eye'), { frameHeight: FRAME }).problem, 'HEAD');
});

test('missing knees, shoulders or hips are reported by name', () => {
  assert.equal(assessBody(without(standing(), 'left_knee'), { frameHeight: FRAME }).problem, 'LEGS');
  assert.equal(assessBody(without(standing(), 'right_shoulder'), { frameHeight: FRAME }).problem, 'TORSO');
  assert.equal(assessBody(without(standing(), 'left_hip', 'right_hip'), { frameHeight: FRAME }).problem, 'TORSO');
});

test('feet are reported before anything else, because "step back" fixes the rest too', () => {
  const everythingWrong = without(standing({ ankleY: 660, eyeY: 10 }), 'left_knee');
  assert.equal(assessBody(everythingWrong, { frameHeight: FRAME }).problem, 'FEET');
});

test('knees at or above the hips are legs the model did not see', () => {
  const waistCut = standing().map((point) => {
    if (point.name?.endsWith('_knee')) return { ...point, y: 400 };
    if (point.name?.endsWith('_ankle')) return { ...point, y: 420, score: 0.6 };
    return point;
  });
  assert.equal(assessBody(waistCut, { frameHeight: FRAME }).complete, false);
  assert.equal(assessBody(waistCut, { frameHeight: FRAME }).problem, 'LEGS');
  assert.equal(assessBody(waistCut).complete, false);
});

import { BODY_GUIDE_BOUNDS } from '../src/lib/cameraGeometry.ts';

test('the feet margin is a thin strip at the bottom of the camera view', () => {
  const boundsBottom = 1 - (BODY_GUIDE_BOUNDS.top + BODY_GUIDE_BOUNDS.height);
  assert.equal(FEET_BOTTOM_MARGIN, 0.02);
  assert.ok(FEET_BOTTOM_MARGIN >= boundsBottom);
});

test('nothing at all is a missing body, not a crash', () => {
  assert.equal(assessBody(undefined).problem, 'FEET');
  assert.equal(assessBody([]).problem, 'FEET');
});

test('every problem has words, and the short form fits under a face', () => {
  for (const problem of ['FEET', 'HEAD', 'LEGS', 'TORSO']) {
    assert.ok(describeBodyProblem(problem).length > 10, `${problem} needs a sentence`);
    const short = shortBodyProblem(problem);
    assert.ok(short && short.split(' ').length <= 2, `${problem} chip must be two words at most`);
  }
  assert.match(describeBodyProblem('FEET'), /step back/i);
  assert.equal(describeBodyProblem(null), null);
  assert.equal(shortBodyProblem(null), null);
});
