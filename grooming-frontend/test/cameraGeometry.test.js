import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BODY_GUIDE_BOUNDS,
  bodyGuideSourceRect,
  coverSourceRect,
} from '../src/lib/cameraGeometry.ts';

test('a wide sensor is cropped at both sides for a portrait preview', () => {
  const crop = coverSourceRect(1920, 1080, 900, 1600);
  assert.equal(crop.y, 0);
  assert.equal(crop.height, 1080);
  assert.ok(crop.x > 0);
  assert.equal(crop.width / crop.height, 900 / 1600);
});

test('a tall sensor is cropped at top and bottom for a wider preview', () => {
  const crop = coverSourceRect(1080, 1920, 1200, 1000);
  assert.equal(crop.x, 0);
  assert.equal(crop.width, 1080);
  assert.ok(crop.y > 0);
  assert.equal(crop.width / crop.height, 1200 / 1000);
});

test('matching aspect ratios save the complete sensor frame', () => {
  assert.deepEqual(coverSourceRect(1080, 1920, 900, 1600), {
    x: 0,
    y: 0,
    width: 1080,
    height: 1920,
  });
});

test('capture saves only the sensor area bounded by the body guide', () => {
  const visible = coverSourceRect(1920, 1080, 900, 1600);
  const crop = bodyGuideSourceRect(1920, 1080, 900, 1600);
  assert.deepEqual(crop, {
    x: visible.x + visible.width * BODY_GUIDE_BOUNDS.left,
    y: visible.y + visible.height * BODY_GUIDE_BOUNDS.top,
    width: visible.width * BODY_GUIDE_BOUNDS.width,
    height: visible.height * BODY_GUIDE_BOUNDS.height,
  });
  assert.ok(crop.x > visible.x);
  assert.ok(crop.y > visible.y);
  assert.ok(crop.width < visible.width);
  assert.ok(crop.height < visible.height);
});

test('guide crop keeps the same proportions on a tablet sensor', () => {
  const crop = bodyGuideSourceRect(1080, 1920, 1200, 1600);
  const expectedAspect = (1200 / 1600)
    * (BODY_GUIDE_BOUNDS.width / BODY_GUIDE_BOUNDS.height);
  assert.ok(Math.abs(crop.width / crop.height - expectedAspect) < Number.EPSILON * 2);
});
