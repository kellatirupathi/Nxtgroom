import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parkCameraStream,
  stopParkedCameraStream,
  takeParkedCameraStream,
} from '../src/lib/cameraStream.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function fakeStream() {
  const track = { readyState: 'live', stopped: 0, stop() { this.stopped += 1; this.readyState = 'ended'; } };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

test('switching screens hands the live camera over instead of restarting it', () => {
  const stream = fakeStream();
  parkCameraStream(stream, 'user', 60_000);
  assert.equal(takeParkedCameraStream('user'), stream);
  assert.equal(stream.track.stopped, 0, 'the camera must keep running through the switch');
  assert.equal(takeParkedCameraStream('user'), null, 'a stream is handed over once');
});

test('the other camera is not handed over, and the parked one is stopped', () => {
  const front = fakeStream();
  parkCameraStream(front, 'user', 60_000);
  assert.equal(takeParkedCameraStream('environment'), null);
  assert.equal(front.track.stopped, 1);
});

test('a camera nobody claims is switched off shortly after', async () => {
  const stream = fakeStream();
  parkCameraStream(stream, 'user', 20);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(stream.track.stopped, 1, 'the camera light must not stay on');
  assert.equal(takeParkedCameraStream('user'), null);
});

test('a stopped stream is never handed over, and parking a new one stops the old', () => {
  const ended = fakeStream();
  ended.track.readyState = 'ended';
  parkCameraStream(ended, 'user', 60_000);
  assert.equal(takeParkedCameraStream('user'), null);

  const first = fakeStream();
  const second = fakeStream();
  parkCameraStream(first, 'user', 60_000);
  parkCameraStream(second, 'user', 60_000);
  assert.equal(first.track.stopped, 1);
  assert.equal(takeParkedCameraStream('user'), second);
});

test('putting the tablet to sleep stops a parked camera too', () => {
  const stream = fakeStream();
  parkCameraStream(stream, 'user', 60_000);
  stopParkedCameraStream();
  assert.equal(stream.track.stopped, 1);
  assert.equal(takeParkedCameraStream('user'), null);
});

test('both screens take over a parked camera and park theirs when they close', () => {
  for (const path of ['src/components/CameraCapture.tsx', 'src/components/GroupCameraCapture.tsx']) {
    const camera = read(path);
    assert.match(camera, /const handedOver = takeParkedCameraStream\(facing\);/, `${path} always reopens the camera`);
    assert.match(camera, /handedOver \?\? await openCameraStream\(\{/, `${path} must still open a camera when none is handed over`);
    assert.match(camera, /if \(current\) parkCameraStream\(current, facing\);/, `${path} stops its camera on close`);
    assert.match(camera, /stopParkedCameraStream\(\);/, `${path} must stop everything when the screen sleeps`);
  }
  const screen = read('src/components/AttendanceScreen.tsx');
  assert.match(screen, /const GROUP_PRELOAD_DELAY_MS = 300;/);
  assert.match(screen, /setGroupScreen\(\(\) => module\.default\)/, 'a loaded group screen should not flash a loader');
});
