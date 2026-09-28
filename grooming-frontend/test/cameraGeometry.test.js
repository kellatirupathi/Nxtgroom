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

test('capture saves exactly what the preview shows - the whole camera view', () => {
  // No outline crops the photo any more: the frame is the whole preview.
  assert.deepEqual(BODY_GUIDE_BOUNDS, { left: 0, top: 0, width: 1, height: 1 });
  const visible = coverSourceRect(1920, 1080, 900, 1600);
  const crop = bodyGuideSourceRect(1920, 1080, 900, 1600);
  assert.deepEqual(crop, visible);
});

test('the single camera draws no outline to stand in', async () => {
  const { readFileSync } = await import('node:fs');
  const camera = readFileSync(new URL('../src/components/CameraCapture.tsx', import.meta.url), 'utf8');
  assert.ok(!camera.includes('BODY_GUIDE_BOUNDS'), 'the outline was drawn from the guide bounds');
  assert.ok(!camera.includes('<rect'), 'an outline shape is drawn on the camera again');
  assert.ok(!/stand in the outline/i.test(camera));
  // What is photographed is still what the preview shows.
  assert.match(camera, /const crop = bodyGuideSourceRect\(/);
});

test('guide crop keeps the same proportions on a tablet sensor', () => {
  const crop = bodyGuideSourceRect(1080, 1920, 1200, 1600);
  const expectedAspect = (1200 / 1600)
    * (BODY_GUIDE_BOUNDS.width / BODY_GUIDE_BOUNDS.height);
  assert.ok(Math.abs(crop.width / crop.height - expectedAspect) < Number.EPSILON * 2);
});
