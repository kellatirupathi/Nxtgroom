import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Mirrors the two rules in location.ts that decide what is submitted. They
 * cannot be imported directly because the module subscribes to the browser
 * geolocation API on load, which does not exist in Node.
 */
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
  // The whole point of watching: a fix from a place the instructor has left
  // is worse than recording no location at all.
  assert.equal(formatCoordinates(fix({ capturedAt: Date.now() - MAX_AGE_MS - 1000 })), null);
  assert.equal(typeof formatCoordinates(fix()), 'string', 'a current fix is submitted');
});

test('a reading too vague to be meaningful is withheld', () => {
  // An IP-derived position can be kilometres out; naming that as the
  // check-in location would be misleading.
  assert.equal(formatCoordinates(fix({ accuracyMetres: 5000 })), null);
  assert.equal(formatCoordinates(fix({ accuracyMetres: 120 })), '17.420796,78.332418');
});

test('a better reading replaces the one held', () => {
  assert.equal(shouldReplace(fix({ accuracyMetres: 80 }), fix({ accuracyMetres: 12 })), true);
  assert.equal(shouldReplace(null, fix()), true, 'the first reading is always taken');
});

test('GPS jitter does not downgrade a good position', () => {
  // Standing still, a 10m fix is often followed by a 90m one. Taking it would
  // repeatedly throw away the better reading.
  const held = fix({ accuracyMetres: 10, capturedAt: Date.now() });
  const noisy = fix({ accuracyMetres: 90, capturedAt: Date.now() + 5_000 });
  assert.equal(shouldReplace(held, noisy), false);
});

test('a worse reading is accepted once the held one has aged out', () => {
  // Otherwise moving somewhere with poorer reception would freeze the old
  // position indefinitely.
  const held = fix({ accuracyMetres: 10, capturedAt: Date.now() });
  const later = fix({ accuracyMetres: 90, capturedAt: Date.now() + PREFER_ACCURATE_WINDOW_MS + 1_000 });
  assert.equal(shouldReplace(held, later), true);
});

test('coordinates are emitted at a fixed precision', () => {
  // Six decimals is about 0.1m, well beyond any accuracy the browser reports,
  // and the backend parses a plain "lat,lon" pair.
  const value = formatCoordinates(fix({ latitude: 17.4207961234, longitude: 78.3324181234 }));
  assert.match(value, /^-?\d+\.\d{6},-?\d+\.\d{6}$/);
});
