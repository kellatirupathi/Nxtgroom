import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraVideoConstraints, tuneCameraTrack } from '../src/lib/cameraStream.ts';

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
