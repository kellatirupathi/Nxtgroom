import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_CAPTURE_CONFIRMATIONS,
  AUTO_CAPTURE_COOLDOWN_MS,
  AUTO_CAPTURE_FALLBACK_ATTEMPTS,
  autoCaptureFallbackDue,
  autoCaptureReady,
  captureConfirmationCount,
  shutterEnabled,
} from '../src/lib/fullBodyDetector.ts';

test('only a confident whole-body frame fires the camera', () => {
  assert.equal(autoCaptureReady('FULL_BODY', AUTO_CAPTURE_CONFIRMATIONS), true);
  for (const verdict of ['PARTIAL', 'TOO_FAR', 'NO_PERSON', 'MULTIPLE_PEOPLE', 'UNAVAILABLE']) {
    assert.equal(
      autoCaptureReady(verdict, AUTO_CAPTURE_CONFIRMATIONS),
      false,
      `${verdict} must not fire an automatic capture`,
    );
  }
});

test('auto-capture is stricter than the manual shutter, deliberately', () => {
  for (const verdict of ['PARTIAL', 'TOO_FAR', 'UNAVAILABLE']) {
    assert.equal(shutterEnabled(verdict, 0, false), true, `${verdict} stays manually capturable`);
    assert.equal(autoCaptureReady(verdict, 99), false, `${verdict} never fires automatically`);
  }
});

test('a good frame has to hold before it fires', () => {
  for (let frames = 0; frames < AUTO_CAPTURE_CONFIRMATIONS; frames += 1) {
    assert.equal(autoCaptureReady('FULL_BODY', frames), false, `${frames} readings is not enough`);
  }
  assert.equal(autoCaptureReady('FULL_BODY', AUTO_CAPTURE_CONFIRMATIONS), true);
});

test('holding longer than required still fires', () => {
  assert.equal(autoCaptureReady('FULL_BODY', AUTO_CAPTURE_CONFIRMATIONS + 20), true);
});

test('multiple people never fire, however long they stand there', () => {
  assert.equal(autoCaptureReady('MULTIPLE_PEOPLE', 1_000), false);
});

test('the manual shutter is offered once a run of frames is unusable', () => {
  assert.equal(autoCaptureFallbackDue(0), false);
  assert.equal(autoCaptureFallbackDue(AUTO_CAPTURE_FALLBACK_ATTEMPTS - 1), false);
  assert.equal(autoCaptureFallbackDue(AUTO_CAPTURE_FALLBACK_ATTEMPTS), true);
  assert.equal(autoCaptureFallbackDue(AUTO_CAPTURE_FALLBACK_ATTEMPTS + 50), true);
});

test('the fallback arrives in a few seconds, not after a minute of waiting', () => {
  const seconds = AUTO_CAPTURE_FALLBACK_ATTEMPTS / 5;
  assert.ok(seconds >= 3 && seconds <= 8, `fallback after ${seconds}s should be a few seconds`);
});

test('the next person is captured only after two seconds and fresh confirmations', () => {
  assert.equal(AUTO_CAPTURE_COOLDOWN_MS, 2_000);
  const end = 10_000 + AUTO_CAPTURE_COOLDOWN_MS;
  let frames = 99;
  for (const now of [10_000, 11_000, end - 1]) {
    frames = captureConfirmationCount('FULL_BODY', frames, false, end, now);
    assert.equal(frames, 0);
    assert.equal(autoCaptureReady('FULL_BODY', frames), false);
  }
  for (let count = 1; count <= AUTO_CAPTURE_CONFIRMATIONS; count += 1) {
    frames = captureConfirmationCount('FULL_BODY', frames, false, end, end + (count - 1) * 200);
    assert.equal(autoCaptureReady('FULL_BODY', frames), count === AUTO_CAPTURE_CONFIRMATIONS);
  }
  assert.equal(captureConfirmationCount('FULL_BODY', 99, true, end, end + 1000), 0);
  assert.equal(captureConfirmationCount('NO_PERSON', 2, false, end, end + 1000), 0);
});

test('the hold is over half a second but under two', () => {
  const ms = (AUTO_CAPTURE_CONFIRMATIONS / 5) * 1_000;
  assert.ok(ms >= 500 && ms <= 2_000, `${ms}ms hold should feel immediate`);
});
