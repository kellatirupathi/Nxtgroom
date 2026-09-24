import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANKLE_CONFIDENCE,
  assessBody,
  describeBodyProblem,
  FEET_BOTTOM_MARGIN,
  shortBodyProblem,
} from '../src/lib/bodyCompleteness.ts';

/**
 * Whether a person is in frame from head to feet.
 *
 * The thing being defended against is a body the model completed by guessing.
 * MoveNet predicts every joint whether it can see it or not, so a person cut
 * off at the knees still arrives with two "ankles" - scored a little lower than
 * real ones, and placed either just below the knees or pushed to the bottom
 * edge of the frame. Each of those signatures gets its own test, because each
 * is caught by a different rule and a fix to one must not quietly disable
 * another.
 */

const FRAME = 1000;

/** A whole person, standing, with a little floor under their feet. */
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
  // And without a frame size, where the edge margins cannot be applied.
  assert.equal(assessBody(standing()).complete, true);
});

test('ankles invented just below the knees are not feet', () => {
  // Legs that end at the knee: the model still emits ankles, a hand's width
  // below the last joint it could see. The shin is a fraction of the thigh.
  const cutAtKnees = standing({ ankleY: 660, ankleScore: 0.6 });
  assert.deepEqual(assessBody(cutAtKnees, { frameHeight: FRAME }), { complete: false, problem: 'FEET' });
  // This one is caught by proportion alone, so it works with no frame size.
  assert.equal(assessBody(cutAtKnees).problem, 'FEET');
});

test('ankles pushed to the bottom edge are not feet', () => {
  // The other place an invented joint lands. And feet on the very edge are
  // feet the photograph has half cut off anyway.
  const edge = standing({ ankleY: FRAME * (1 - FEET_BOTTOM_MARGIN) + 5, ankleScore: 0.7 });
  assert.equal(assessBody(edge, { frameHeight: FRAME }).problem, 'FEET');
  // Just inside the margin is fine.
  const inside = standing({ ankleY: FRAME * (1 - FEET_BOTTOM_MARGIN) - 5, ankleScore: 0.7 });
  assert.equal(assessBody(inside, { frameHeight: FRAME }).complete, true);
});

test('an ankle below the stricter confidence floor is not a foot', () => {
  // Above the general floor, below the ankle one: exactly where a predicted
  // joint for an unseen leg tends to score.
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
  // Without hips the shin proportion cannot be measured, and that must not be
  // mistaken for a proportion that passed.
  assert.equal(assessBody(without(standing(), 'left_hip', 'right_hip'), { frameHeight: FRAME }).problem, 'TORSO');
});

test('feet are reported before anything else, because "step back" fixes the rest too', () => {
  const everythingWrong = without(standing({ ankleY: 660, eyeY: 10 }), 'left_knee');
  assert.equal(assessBody(everythingWrong, { frameHeight: FRAME }).problem, 'FEET');
});

test('knees at or above the hips are legs the model did not see', () => {
  // A person cut off at the waist: MoveNet still emits knees and ankles, and
  // with nothing below the waist to anchor them they land wherever - often
  // above the hips, with "ankles" a few pixels under. An earlier draft of this
  // check excused that as somebody sitting, which is exactly the frame the
  // owner reported being photographed. Nobody sits for attendance.
  const waistCut = standing().map((point) => {
    if (point.name?.endsWith('_knee')) return { ...point, y: 400 };
    if (point.name?.endsWith('_ankle')) return { ...point, y: 420, score: 0.6 };
    return point;
  });
  assert.equal(assessBody(waistCut, { frameHeight: FRAME }).complete, false);
  assert.equal(assessBody(waistCut, { frameHeight: FRAME }).problem, 'LEGS');
  // And it needs no frame size to catch: the shape of the leg is enough.
  assert.equal(assessBody(waistCut).complete, false);
});

import { BODY_GUIDE_BOUNDS } from '../src/lib/cameraGeometry.ts';

test('the feet margin is the outline the person was asked to stand in', () => {
  // A gate stricter than the outline drawn on screen is a rule nobody can
  // follow: standing where the outline says is answered with "step back", and
  // stepping back drops out of the distance rule, and the person shuffles
  // between the two until the manual button appears. One constant, not two.
  const outlineBottom = 1 - (BODY_GUIDE_BOUNDS.top + BODY_GUIDE_BOUNDS.height);
  assert.ok(
    Math.abs(FEET_BOTTOM_MARGIN - outlineBottom) < 1e-6,
    `feet margin ${FEET_BOTTOM_MARGIN} disagrees with the outline's ${outlineBottom}`,
  );
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
