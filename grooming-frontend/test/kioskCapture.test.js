import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the camera keeps its firing lock until capture handling completes', () => {
  const camera = read('src/components/CameraCapture.tsx');
  assert.match(camera, /await onCapture\(/);
  assert.ok(
    camera.indexOf('await onCapture(') < camera.indexOf('firingRef.current = false'),
    'the firing lock must be released after the request, not after JPEG encoding',
  );
});

test('the kiosk returns its request promise to the camera', () => {
  const kiosk = read('src/components/KioskAttendance.tsx');
  assert.match(kiosk, /onCapture=\{submit\}/);
  assert.match(kiosk, /if \(submitInFlight\.current\) return/);
});

test('all attendance camera flows open the front camera by default', () => {
  const kiosk = read('src/components/KioskAttendance.tsx');
  const evaluation = read('src/components/EvaluateCard.tsx');
  const frontCameraDefault = /useState<'user' \| 'environment'>\('user'\)/;
  assert.match(kiosk, frontCameraDefault);
  assert.match(evaluation, frontCameraDefault);
});

test('duplicate conflicts are neutral results and transient errors expire', () => {
  const kiosk = read('src/components/KioskAttendance.tsx');
  assert.match(kiosk, /requestError\.status === 409/);
  assert.match(kiosk, /tone: 'info'/);
  assert.match(kiosk, /setTimeout\(\(\) => setError\(''\), 5_000\)/);
});
