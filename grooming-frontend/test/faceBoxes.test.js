import test from 'node:test';
import assert from 'node:assert/strict';
import { faceBoxPixels, faceBoxesFromPoses } from '../src/lib/faceBoxes.ts';
import { readPoses, readKeypoints } from '../src/lib/fullBodyDetector.ts';

/**
 * The boxes drawn on faces in the live preview.
 *
 * Decoration, and the tests are written on that basis: the thing that must stay
 * true is that adding them changed no decision anywhere. A box is shown to the
 * person in front of the camera and read by nothing.
 *
 * The one property that genuinely matters for the person looking at it is
 * mirroring. The front-camera preview is flipped, and a box drawn without
 * accounting for that lands on the opposite side of the screen from the face —
 * which looks like a bug in the face detection rather than in an overlay, and
 * the front camera is now the default everywhere.
 */

const FRAME = { frameWidth: 480, frameHeight: 360 };

/** One person, with their head around `x`. */
function person(x, { landmarks = 'full', shoulders = true, id } = {}) {
  const head = {
    full: [
      { name: 'nose', score: 0.9, x, y: 100 },
      { name: 'left_eye', score: 0.9, x: x - 8, y: 94 },
      { name: 'right_eye', score: 0.9, x: x + 8, y: 94 },
      { name: 'left_ear', score: 0.8, x: x - 18, y: 98 },
      { name: 'right_ear', score: 0.8, x: x + 18, y: 98 },
    ],
    one: [{ name: 'nose', score: 0.9, x, y: 100 }],
    none: [{ name: 'nose', score: 0.05, x, y: 100 }],
  }[landmarks];
  return {
    ...(id == null ? {} : { id }),
    keypoints: [
      ...head,
      ...(shoulders ? [
        { name: 'left_shoulder', score: 0.9, x: x - 40, y: 160 },
        { name: 'right_shoulder', score: 0.9, x: x + 40, y: 160 },
      ] : []),
    ],
  };
}

test('a box covers the face it was built from', () => {
  const [box] = faceBoxesFromPoses([person(240)], FRAME);

  const left = box.left * FRAME.frameWidth;
  const right = (box.left + box.width) * FRAME.frameWidth;
  const top = box.top * FRAME.frameHeight;
  const bottom = (box.top + box.height) * FRAME.frameHeight;

  // Both ears are inside it, and so is the nose.
  assert.ok(left < 222 && right > 258, `box spans ${left}-${right}, ears are at 222 and 258`);
  assert.ok(top < 94 && bottom > 100, `box spans ${top}-${bottom}, eyes at 94 and nose at 100`);
  // A face is taller than it is wide, in pixels rather than in ratios.
  assert.ok((bottom - top) > (right - left));
  assert.equal(box.confident, true);
});

test('the front camera mirrors the box, or it lands on the wrong person', () => {
  const [normal] = faceBoxesFromPoses([person(120)], FRAME);
  const [mirrored] = faceBoxesFromPoses([person(120)], { ...FRAME, mirrored: true });

  assert.equal(mirrored.width, normal.width, 'mirroring must not resize anything');
  assert.equal(mirrored.top, normal.top, 'mirroring is horizontal only');

  // A face a quarter of the way across becomes one three quarters across: the
  // two boxes must sit either side of the centre line, the same distance from it.
  const normalCentre = normal.left + normal.width / 2;
  const mirroredCentre = mirrored.left + mirrored.width / 2;
  assert.ok(Math.abs((normalCentre + mirroredCentre) - 1) < 1e-9, 'the mirror is not about the centre');
  assert.ok(normalCentre < 0.5 && mirroredCentre > 0.5);
});

test('the single-person camera draws one box, and it is the nearest face', () => {
  // Somebody walking past in the background must not steal the box from the
  // person standing at the tablet. Largest face wins, which is the closest one.
  const near = person(240);
  const far = {
    keypoints: person(80).keypoints.map((point) => ({
      ...point,
      x: 80 + (point.x - 80) * 0.3,
      y: 60 + (point.y - 100) * 0.3,
    })),
  };

  const one = faceBoxesFromPoses([far, near], { ...FRAME, limit: 1 });
  assert.equal(one.length, 1);
  assert.ok(
    Math.abs((one[0].left + one[0].width / 2) - 0.5) < 0.1,
    'the box should be on the person in the middle, who is nearest',
  );

  // Without a limit both are drawn, which is what the group camera asks for.
  assert.equal(faceBoxesFromPoses([far, near], FRAME).length, 2);
});

test('a face turned away is boxed but marked unconfident', () => {
  // The group screen colours these amber and labels them, which is what turns
  // "2 people are not facing the camera" into something actionable.
  const [box] = faceBoxesFromPoses([person(240, { landmarks: 'one' })], FRAME);
  assert.equal(box.confident, false);
  assert.ok(box.width > 0, 'they are still a person, and still worth showing');

  const [confident] = faceBoxesFromPoses([person(240)], FRAME);
  assert.equal(confident.confident, true);
});

test('shoulders give the scale when the face barely shows', () => {
  // One landmark spans no width at all, so a box built from it alone would be a
  // dot on somebody's cheek.
  const withShoulders = faceBoxPixels(person(240, { landmarks: 'one' }), 0.35);
  const without = faceBoxPixels(person(240, { landmarks: 'one', shoulders: false }), 0.35);

  assert.ok(withShoulders.width > 20, `a head from 80px shoulders came out ${withShoulders.width}px`);
  assert.equal(without, null, 'with no width to be had, there is no box to draw');
});

test('nobody visible means no box', () => {
  assert.deepEqual(faceBoxesFromPoses([], FRAME), []);
  assert.deepEqual(faceBoxesFromPoses(undefined, FRAME), []);
  assert.deepEqual(faceBoxesFromPoses([person(240, { landmarks: 'none' })], FRAME), []);
  assert.equal(faceBoxPixels({ keypoints: [] }, 0.35), null);
});

test('a box never escapes the preview', () => {
  // Somebody at the very edge of the frame has part of their head outside it.
  for (const x of [2, 478]) {
    for (const mirrored of [false, true]) {
      const [box] = faceBoxesFromPoses([person(x)], { ...FRAME, mirrored });
      assert.ok(box.left >= 0 && box.top >= 0, `box at x=${x} started outside the frame`);
      assert.ok(box.width <= 1 && box.height <= 1);
    }
  }
});

test('an unusable frame size produces nothing rather than an infinity', () => {
  assert.deepEqual(faceBoxesFromPoses([person(240)], { frameWidth: 0, frameHeight: 360 }), []);
  assert.deepEqual(faceBoxesFromPoses([person(240)], { frameWidth: 480, frameHeight: 0 }), []);
});

test('boxes come back in reading order with stable keys', () => {
  const boxes = faceBoxesFromPoses([person(400), person(100), person(250)], FRAME);
  assert.deepEqual(
    boxes.map((box) => box.left),
    [...boxes.map((box) => box.left)].sort((a, b) => a - b),
    'left to right, so React does not reorder elements under a CSS transition',
  );

  // A tracked person keeps their key as they move, so the box animates across
  // rather than one disappearing and another appearing.
  const [first] = faceBoxesFromPoses([person(100, { id: 7 })], FRAME);
  const [moved] = faceBoxesFromPoses([person(160, { id: 7 })], FRAME);
  assert.equal(first.key, moved.key);
  assert.notEqual(first.left, moved.left);
});

test('drawing boxes changed no capture decision', () => {
  // The whole claim. readPoses and readKeypoints are what gate a capture, and
  // neither knows the overlay exists.
  const group = [person(100), person(300)];
  assert.equal(readPoses(group, 360, 480).verdict, 'MULTIPLE_PEOPLE');
  assert.equal(readPoses([], 360, 480).verdict, 'NO_PERSON');
  assert.equal(readKeypoints(undefined).verdict, 'NO_PERSON');

  for (const reading of [readPoses(group, 360, 480), readKeypoints(person(100).keypoints)]) {
    assert.equal('boxes' in reading, false, 'the gate must not be carrying overlay data');
  }
});
