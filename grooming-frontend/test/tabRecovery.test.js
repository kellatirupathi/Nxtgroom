import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CAMERA_BUSY_ERRORS,
  CAMERA_RETRY_DELAYS_MS,
  openCameraStream,
} from '../src/lib/cameraStream.ts';
import {
  CHUNK_RELOAD_COOLDOWN_MS,
  isChunkLoadError,
  memoizedImport,
  reloadForNewDeployment,
} from '../src/lib/chunkRecovery.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * Why the Group tab sometimes did not open, and what now stops it.
 *
 * Three separate causes, each with its own fix and tests here:
 *
 *  1. Switching tabs closed one camera and opened another in the same instant.
 *     Android releases the camera a moment after it is closed, so the second
 *     request was refused as "in use" and nothing asked again.
 *  2. The group screen's code was downloaded on first click, from a file a
 *     later deployment removes. A tablet open across a deployment crashed the
 *     whole app when Group was clicked.
 *  3. A tablet whose screen slept came back to a black camera, because the
 *     stream released on sleep was never reopened.
 */

const busy = () => Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' });

function fakeDevices(outcomes) {
  const calls = [];
  return {
    calls,
    getUserMedia: async (constraints) => {
      calls.push(constraints);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const noWait = () => Promise.resolve();

test('a camera still held by the previous screen is asked again, and opens', async () => {
  const stream = { id: 'stream-1' };
  const devices = fakeDevices([busy(), busy(), stream]);
  const waits = [];
  const opened = await openCameraStream(
    { video: true },
    { mediaDevices: devices, wait: async (ms) => { waits.push(ms); } },
  );
  assert.equal(opened, stream);
  assert.equal(devices.calls.length, 3);
  assert.deepEqual(waits, [250, 500], 'a growing pause between attempts');
});

test('a camera that stays busy is reported after about three seconds, not forever', async () => {
  const devices = fakeDevices(Array.from({ length: 10 }, busy));
  await assert.rejects(
    () => openCameraStream({ video: true }, { mediaDevices: devices, wait: noWait }),
    { name: 'NotReadableError' },
  );
  assert.equal(devices.calls.length, CAMERA_RETRY_DELAYS_MS.length + 1);
  const total = CAMERA_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
  assert.ok(total >= 2000 && total <= 4000, `the retries span ${total}ms`);
});

test('a refusal waiting cannot fix is reported at once', async () => {
  for (const name of ['NotAllowedError', 'NotFoundError', 'OverconstrainedError', 'SecurityError']) {
    assert.equal(CAMERA_BUSY_ERRORS.has(name), false);
    const devices = fakeDevices([Object.assign(new Error(name), { name })]);
    await assert.rejects(() => openCameraStream({ video: true }, { mediaDevices: devices, wait: noWait }), { name });
    assert.equal(devices.calls.length, 1, `${name} must not be retried`);
  }
});

test('no retry outlives the screen that asked', async () => {
  let gone = false;
  const devices = fakeDevices([busy(), { id: 'too-late' }]);
  await assert.rejects(() => openCameraStream(
    { video: true },
    { mediaDevices: devices, isCancelled: () => gone, wait: async () => { gone = true; } },
  ));
  assert.equal(devices.calls.length, 1, 'the screen left during the pause, so nothing was asked again');
});

test('a screen whose code was deployed away is recognised in every browser\'s words', () => {
  for (const message of [
    'Failed to fetch dynamically imported module: https://app/assets/GroupKioskAttendance-abc.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/x.css',
    'Loading chunk 42 failed.',
  ]) {
    assert.equal(isChunkLoadError(new TypeError(message)), true, message);
  }
  assert.equal(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' })), true);
  // A screen that is broken, as opposed to missing, is not reloaded away.
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')")), false);
  assert.equal(isChunkLoadError(null), false);
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

test('the page reloads for a new deployment once, never in a loop', () => {
  const storage = memoryStorage();
  let reloads = 0;
  const reload = () => { reloads += 1; };

  assert.equal(reloadForNewDeployment({ storage, now: 1_000_000, reload }), true);
  assert.equal(reloads, 1);
  // Still missing after the reload: a real outage, not a deployment. No loop.
  assert.equal(reloadForNewDeployment({ storage, now: 1_000_000 + 5_000, reload }), false);
  assert.equal(reloads, 1);
  // A minute later it may try again.
  assert.equal(reloadForNewDeployment({ storage, now: 1_000_000 + CHUNK_RELOAD_COOLDOWN_MS + 1, reload }), true);
  assert.equal(reloads, 2);
  // With no storage there is no loop guard, so there is no reload either.
  assert.equal(reloadForNewDeployment({ storage: null, now: 5, reload }), false);
  assert.equal(reloads, 2);
});

test('the screen code is fetched once, and a failed fetch is tried again', async () => {
  let fetches = 0;
  let fail = true;
  const load = memoizedImport(async () => {
    fetches += 1;
    if (fail) throw new TypeError('Failed to fetch dynamically imported module');
    return { default: 'GroupScreen' };
  });
  await assert.rejects(load());
  fail = false;
  const [first, second] = await Promise.all([load(), load()]);
  assert.equal(first.default, 'GroupScreen');
  assert.equal(first, second, 'the preload and the click share one download');
  assert.equal(fetches, 2, 'one failed attempt, then one that succeeded - never more');
});

test('the attendance screen preloads Group and keeps its failures inside the panel', () => {
  const screen = read('src/components/AttendanceScreen.tsx');
  assert.match(screen, /const loadGroupScreen = memoizedImport\(\(\) => import\('\.\/GroupKioskAttendance'\)\)/);
  assert.match(screen, /loadGroupScreen\(\)\.catch\(\(\) => \{\}\)/, 'the group screen is fetched in the background');
  assert.match(screen, /<GroupScreenBoundary key=\{groupAttempt\} onRetry=\{retryGroup\}>/);
  assert.match(screen, /setGroupScreen\(\(\) => lazy\(loadGroupScreen\)\)/, 'a retry needs a fresh lazy component');
});

test('both cameras retry a busy camera, and reopen after the screen sleeps', () => {
  for (const path of ['src/components/CameraCapture.tsx', 'src/components/GroupCameraCapture.tsx']) {
    const camera = read(path);
    assert.match(camera, /await openCameraStream\(\{/, `${path} must retry a busy camera`);
    assert.ok(!camera.includes('navigator.mediaDevices.getUserMedia('), `${path} still opens the camera directly`);
    assert.match(camera, /isCancelled: \(\) => disposed/, `${path} must not retry after it has gone`);
    assert.match(
      camera,
      /else if \(!streamRef\.current && !openingRef\.current\) \{\s*setStreamGeneration/,
      `${path} must reopen the camera when the screen wakes`,
    );
    assert.match(camera, /\}, \[facing, stop, streamGeneration\]\);/, `${path} must reopen on a new generation`);
  }
});

test('both cameras say "hold still" while the still is being taken', () => {
  const single = read('src/components/CameraCapture.tsx');
  assert.match(single, /autoCapture && \(capturing \|\| \(steadyFrames > 0 && steadyFrames < AUTO_CAPTURE_CONFIRMATIONS\)\)/);
  const group = read('src/components/GroupCameraCapture.tsx');
  assert.match(group, /capturing \|\| \(steadyFrames > 0 && steadyFrames < GROUP_CAPTURE_CONFIRMATIONS\)/);
});
