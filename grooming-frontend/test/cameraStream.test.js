import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraVideoConstraints, MAX_VIDEO_LONG_SIDE, raiseCameraResolution, tuneCameraTrack, videoSizeCandidates } from '../src/lib/cameraStream.ts';

function fakeTrack(capabilities, { failApply = false } = {}) {
  const applied = [];
  return {
    applied,
    getCapabilities: () => capabilities,
    applyConstraints: async (constraints) => {
      if (failApply) throw new Error('OverconstrainedError');
      applied.push(constraints);
    },
  };
}

test('the camera is asked for a higher resolution than full HD, as an ideal it may fall short of', () => {
  const constraints = cameraVideoConstraints('user');
  assert.deepEqual(constraints.facingMode, { ideal: 'user' });
  assert.deepEqual(constraints.width, { ideal: 2560 });
  assert.deepEqual(constraints.height, { ideal: 1440 });
  assert.deepEqual(cameraVideoConstraints('environment').facingMode, { ideal: 'environment' });
});

test('continuous focus, exposure and white balance are switched on where the camera offers them', async () => {
  const track = fakeTrack({
    focusMode: ['manual', 'single-shot', 'continuous'],
    exposureMode: ['continuous'],
    whiteBalanceMode: ['manual'],
  });
  await tuneCameraTrack(track);
  assert.deepEqual(track.applied, [{ advanced: [{ focusMode: 'continuous' }, { exposureMode: 'continuous' }] }]);
});

test('a camera with nothing to tune, or that refuses, is left as it is', async () => {
  const plain = fakeTrack({ width: { max: 1920 } });
  await tuneCameraTrack(plain);
  assert.deepEqual(plain.applied, []);

  await tuneCameraTrack(fakeTrack({ focusMode: ['continuous'] }, { failApply: true }));
  await tuneCameraTrack({ getCapabilities: () => { throw new Error('not supported'); }, applyConstraints: async () => {} });
  await tuneCameraTrack({});
  await tuneCameraTrack(null);
});

function sizedTrack({ maxWidth, maxHeight, start, accepts }) {
  let size = { ...start };
  const tried = [];
  return {
    tried,
    getCapabilities: () => ({ width: { min: 1, max: maxWidth }, height: { min: 1, max: maxHeight } }),
    getSettings: () => ({ ...size }),
    applyConstraints: async (constraints) => {
      if (!constraints.width) return;
      const next = { width: constraints.width.exact, height: constraints.height.exact };
      tried.push(`${next.width}x${next.height}`);
      if (!accepts(next)) throw Object.assign(new Error('Overconstrained'), { name: 'OverconstrainedError' });
      size = next;
    },
  };
}

test('an upright iPad camera opened at 960x1280 is raised to the largest portrait size it accepts', async () => {
  const track = sizedTrack({
    maxWidth: 1920,
    maxHeight: 1920,
    start: { width: 960, height: 1280 },
    accepts: ({ width, height }) => Math.max(width, height) <= 1920,
  });
  const result = await raiseCameraResolution(track);
  assert.deepEqual(result, { width: 1440, height: 1920 });
  assert.deepEqual(track.tried, ['1440x1920'], 'sizes beyond the reported maximum are not even tried');
});

test('a landscape Android camera is raised in landscape, skipping sizes it refuses', async () => {
  const track = sizedTrack({
    maxWidth: 3840,
    maxHeight: 2160,
    start: { width: 1280, height: 720 },
    accepts: ({ width }) => width !== 3840,
  });
  const result = await raiseCameraResolution(track);
  assert.deepEqual(result, { width: 2560, height: 1920 });
  assert.deepEqual(track.tried, ['3840x2160', '2560x1920']);
});

test('the raise never goes above 3840 or below what the camera already gives', () => {
  const sizes = videoSizeCandidates({ width: { max: 8000 }, height: { max: 6000 } }, { width: 1920, height: 1080 });
  assert.deepEqual(sizes.map((s) => `${s.width}x${s.height}`), ['3840x2160', '2560x1920', '2560x1440']);
  assert.ok(sizes.every((s) => Math.max(s.width, s.height) <= MAX_VIDEO_LONG_SIDE));
  assert.deepEqual(videoSizeCandidates({}, { width: 960, height: 1280 }), [], 'no reported maximum, no change');
});

test('a camera that cannot be raised is left exactly as it was', async () => {
  const track = sizedTrack({ maxWidth: 1280, maxHeight: 1280, start: { width: 960, height: 1280 }, accepts: () => true });
  assert.equal(await raiseCameraResolution(track), null);
  assert.deepEqual(track.tried, []);
  assert.equal(await raiseCameraResolution({}), null);
  assert.equal(await raiseCameraResolution(null), null);
});
