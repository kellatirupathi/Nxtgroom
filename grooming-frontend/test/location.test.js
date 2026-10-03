import test from 'node:test';
import assert from 'node:assert/strict';

const MAX_AGE_MS = 5 * 60_000;
const USABLE_ACCURACY_M = 2000;
const PREFER_ACCURATE_WINDOW_MS = 30_000;

function formatCoordinates(fix) {
  if (!fix) return null;
  if (fix.accuracyMetres > USABLE_ACCURACY_M) return null;
  if (Date.now() - fix.capturedAt > MAX_AGE_MS) return null;
  return `${fix.latitude.toFixed(6)},${fix.longitude.toFixed(6)}`;
}

function shouldReplace(current, next) {
  if (!current) return true;
  if (next.accuracyMetres <= current.accuracyMetres) return true;
  return next.capturedAt - current.capturedAt > PREFER_ACCURATE_WINDOW_MS;
}

const fix = (over = {}) => ({
  latitude: 17.420796,
  longitude: 78.332418,
  accuracyMetres: 20,
  capturedAt: Date.now(),
  ...over,
});

test('a stale position is withheld rather than submitted', () => {
  assert.equal(formatCoordinates(fix({ capturedAt: Date.now() - MAX_AGE_MS - 1000 })), null);
  assert.equal(typeof formatCoordinates(fix()), 'string', 'a current fix is submitted');
});

test('a reading too vague to be meaningful is withheld', () => {
  assert.equal(formatCoordinates(fix({ accuracyMetres: 5000 })), null);
  assert.equal(formatCoordinates(fix({ accuracyMetres: 120 })), '17.420796,78.332418');
});

test('a better reading replaces the one held', () => {
  assert.equal(shouldReplace(fix({ accuracyMetres: 80 }), fix({ accuracyMetres: 12 })), true);
  assert.equal(shouldReplace(null, fix()), true, 'the first reading is always taken');
});

test('GPS jitter does not downgrade a good position', () => {
  const held = fix({ accuracyMetres: 10, capturedAt: Date.now() });
  const noisy = fix({ accuracyMetres: 90, capturedAt: Date.now() + 5_000 });
  assert.equal(shouldReplace(held, noisy), false);
});

test('a worse reading is accepted once the held one has aged out', () => {
  const held = fix({ accuracyMetres: 10, capturedAt: Date.now() });
  const later = fix({ accuracyMetres: 90, capturedAt: Date.now() + PREFER_ACCURATE_WINDOW_MS + 1_000 });
  assert.equal(shouldReplace(held, later), true);
});

test('coordinates are emitted at a fixed precision', () => {
  const value = formatCoordinates(fix({ latitude: 17.4207961234, longitude: 78.3324181234 }));
  assert.match(value, /^-?\d+\.\d{6},-?\d+\.\d{6}$/);
});
