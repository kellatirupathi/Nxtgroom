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
  const kiosk = read('src/components/AttendanceScreen.tsx');
  const evaluation = read('src/components/EvaluateCard.tsx');
  const frontCameraDefault = /useState<'user' \| 'environment'>\('user'\)/;
  assert.match(kiosk, frontCameraDefault);
  assert.match(evaluation, frontCameraDefault);
});

test('a result stays up for five seconds, and the camera pauses meanwhile', () => {
  for (const [screen, camera] of [
    ['src/components/KioskAttendance.tsx', 'src/components/CameraCapture.tsx'],
    ['src/components/GroupKioskAttendance.tsx', 'src/components/GroupCameraCapture.tsx'],
  ]) {
    const source = read(screen);
    assert.match(source, /const RESULT_VISIBLE_MS = 5_000;/, `${screen} must show its result for 5 seconds`);
    assert.match(source, /setTimeout\(\(\) => setResult\(null\), RESULT_VISIBLE_MS\)/);
    assert.match(source, /paused=\{Boolean\(result\) \|\| submitting\}/, `${screen} lets its camera fire under the result`);
    const capture = read(camera);
    const paused = capture.indexOf('if (pausedRef.current) {');
    assert.ok(paused > 0, `${camera} ignores the pause`);
    assert.ok(paused < capture.indexOf('readWithTurn(tracker, read)'), `${camera} must stop before analysing`);
  }
});

test('the messages on both screens turn with the people in the picture', () => {
  for (const [screen, camera] of [
    ['src/components/KioskAttendance.tsx', 'CameraCapture'],
    ['src/components/GroupKioskAttendance.tsx', 'GroupCameraCapture'],
  ]) {
    const source = read(screen);
    assert.match(source, /onTurn=\{setTurn\}/, `${screen} does not hear which way ${camera} is turned`);
    assert.match(source, /<TurnedLayer turn=\{turn\}/);
    const layer = source.indexOf('<TurnedLayer turn={turn}');
    assert.ok(source.indexOf('{result && (') > layer, `${screen} must turn its result with the layer`);
  }
});

test('duplicate conflicts are neutral results and transient errors expire', () => {
  const kiosk = read('src/components/KioskAttendance.tsx');
  assert.match(kiosk, /requestError\.status === 409/);
  assert.match(kiosk, /tone: 'info'/);
  assert.match(kiosk, /setTimeout\(\(\) => setError\(''\), 5_000\)/);
});
