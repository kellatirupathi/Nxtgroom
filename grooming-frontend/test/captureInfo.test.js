import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCapture, deviceModel } from '../src/lib/captureInfo.ts';

test('the tablet model is read from the browser, without the build number', () => {
  assert.equal(
    deviceModel('Mozilla/5.0 (Linux; Android 14; SM-X200 Build/UP1A.231005.007; wv) AppleWebKit/537.36 Chrome/128.0 Safari/537.36'),
    'Android: SM-X200',
  );
  assert.equal(deviceModel('Mozilla/5.0 (Linux; Android 13; Lenovo TB-X606F) AppleWebKit/537.36'), 'Android: Lenovo TB-X606F');
  assert.equal(deviceModel(undefined), undefined);
});

test('the capture report carries the photo, the camera settings and the still outcome', () => {
  const photo = {
    blob: { size: 312000 },
    source: 'video',
    width: 960,
    height: 1193,
    diagnostics: { source: 'video', video: '1080x1920', region: '960x1193', output: '960x1193', still: { outcome: 'no-match', score: 0.4 } },
  };
  const track = { getSettings: () => ({ width: 1080, height: 1920, frameRate: 29.97, facingMode: 'user', focusMode: 'continuous', deviceId: 'secret' }) };
  const info = describeCapture(photo, track, 'Mozilla/5.0 (Linux; Android 14; SM-X200 Build/X; wv)');
  assert.deepEqual(info, {
    source: 'video',
    video: '1080x1920',
    region: '960x1193',
    output: '960x1193',
    bytes: 312000,
    still: { outcome: 'no-match', score: 0.4 },
    camera: { width: 1080, height: 1920, frameRate: 30, facingMode: 'user', focusMode: 'continuous' },
    device: 'Android: SM-X200',
  });
  assert.equal(describeCapture({ ...photo, diagnostics: undefined }, track), null);
  assert.equal(describeCapture(photo, { getSettings: () => { throw new Error('x'); } }, '').camera, undefined);
});
