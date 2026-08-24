import test from 'node:test';
import assert from 'node:assert/strict';
import { coverSourceRect } from '../src/lib/cameraGeometry.ts';

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
