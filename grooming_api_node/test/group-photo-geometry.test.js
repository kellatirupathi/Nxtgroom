import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bodyCoverage,
  faceSearchCrop,
  normalizeBoundingBox,
  personBodyCrop,
  sortFacesForDisplay,
} from "../src/services/groupPhotoGeometry.js";

/**
 * A group photograph is turned into one crop per person by arithmetic alone,
 * which is the only part of the feature that can be argued about without a
 * camera, a collection or a bill.
 *
 * Two properties matter more than the exact numbers. The face crop must stay
 * tight, because SearchFacesByImage answers about the largest face it finds and
 * a loose crop hands it the wrong one. And every rectangle must land inside the
 * image, because sharp refuses an out-of-bounds extract with an error that
 * names neither the face nor the person it belonged to.
 */

/** A face box as Rekognition reports one: ratios of the whole image. */
const face = (left, top, width, height) => ({ Left: left, Top: top, Width: width, Height: height });

const WIDTH = 1600;
const HEIGHT = 1200;

function inside(rect, width = WIDTH, height = HEIGHT) {
  return rect
    && rect.left >= 0
    && rect.top >= 0
    && rect.width >= 1
    && rect.height >= 1
    && rect.left + rect.width <= width
    && rect.top + rect.height <= height;
}

test("a face box out of the frame is clamped rather than rejected", () => {
  // Rekognition reports the whole face even when half of it was not
  // photographed, so Left is negative and Left+Width can exceed 1.
  const edge = normalizeBoundingBox(face(-0.04, -0.02, 0.1, 0.12));
  assert.equal(edge.left, -0.04, "the ratio itself is preserved for the arithmetic");

  for (const box of [
    face(-0.04, -0.02, 0.1, 0.12),
    face(0.95, 0.9, 0.12, 0.15),
    face(0, 0, 1, 1),
  ]) {
    assert.ok(inside(faceSearchCrop(box, WIDTH, HEIGHT)), "face crop escaped the image");
    assert.ok(inside(personBodyCrop(box, WIDTH, HEIGHT)), "body crop escaped the image");
  }
});

test("a box with no area produces no crop at all", () => {
  for (const box of [face(0.1, 0.1, 0, 0.2), face(0.1, 0.1, 0.2, 0), null, undefined, {}]) {
    assert.equal(normalizeBoundingBox(box), null);
    assert.equal(faceSearchCrop(box, WIDTH, HEIGHT), null);
    assert.equal(personBodyCrop(box, WIDTH, HEIGHT), null);
  }
});

test("the search crop stays tight enough that the intended face is the largest one", () => {
  // Two people standing a face-width apart. The crop taken for the left one
  // must not reach the right one, or Rekognition may answer about the neighbour
  // and file this person's attendance under their name.
  const left = face(0.30, 0.20, 0.08, 0.10);
  const right = face(0.46, 0.20, 0.08, 0.10);
  const crop = faceSearchCrop(left, WIDTH, HEIGHT);
  const neighbourLeftEdge = right.Left * WIDTH;

  assert.ok(
    crop.left + crop.width <= neighbourLeftEdge,
    `the search crop reaches ${crop.left + crop.width}px, into a neighbour starting at ${neighbourLeftEdge}px`,
  );
  // And it must still contain the whole face it is about.
  assert.ok(crop.left <= left.Left * WIDTH);
  assert.ok(crop.left + crop.width >= (left.Left + left.Width) * WIDTH);
});

test("the body crop reaches well below the face, and is taller than it is wide", () => {
  const box = face(0.45, 0.08, 0.06, 0.08);
  const crop = personBodyCrop(box, WIDTH, HEIGHT);

  assert.ok(crop.height > crop.width, "a standing person is taller than they are wide");
  const faceBottom = (box.Top + box.Height) * HEIGHT;
  assert.ok(
    crop.top + crop.height > faceBottom * 3,
    "the crop stops too close to the face to contain a shirt, a waistband or shoes",
  );
  // The head is included: the box starts at the hairline, and the crown is above it.
  assert.ok(crop.top <= box.Top * HEIGHT);
});

test("a crop cut off by the frame reports how much of the person it caught", () => {
  // Somebody standing near the bottom of the photograph: the frame ends before
  // their feet do. The report they get will have nothing to say about footwear,
  // and this is the number that explains why.
  const low = face(0.45, 0.62, 0.06, 0.08);
  const high = face(0.45, 0.04, 0.06, 0.08);

  const clipped = bodyCoverage(low, WIDTH, HEIGHT);
  const whole = bodyCoverage(high, WIDTH, HEIGHT);

  assert.ok(clipped < 0.75, `a person at the bottom edge reported ${clipped} coverage`);
  assert.ok(whole > clipped, "a person with room below them must score higher");
  assert.ok(whole <= 1);
});

test("people are listed the way somebody looking at them would read them", () => {
  const back = { id: "back-left", box: { left: 0.10, top: 0.05, width: 0.05, height: 0.06 } };
  const backRight = { id: "back-right", box: { left: 0.60, top: 0.05, width: 0.05, height: 0.06 } };
  const front = { id: "front-left", box: { left: 0.15, top: 0.40, width: 0.08, height: 0.10 } };
  const frontRight = { id: "front-right", box: { left: 0.55, top: 0.40, width: 0.08, height: 0.10 } };

  const order = sortFacesForDisplay([frontRight, back, front, backRight]).map((entry) => entry.id);
  assert.deepEqual(order, ["back-left", "back-right", "front-left", "front-right"]);
});

test("a face with no usable box is dropped from the display order, not sorted to the front", () => {
  const good = { id: "good", box: { left: 0.2, top: 0.2, width: 0.06, height: 0.08 } };
  const broken = { id: "broken", box: { left: 0.1, top: 0.1, width: 0, height: 0 } };
  assert.deepEqual(sortFacesForDisplay([broken, good]).map((entry) => entry.id), ["good"]);
});
