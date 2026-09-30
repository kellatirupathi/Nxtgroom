/**
 * A brief per-tablet hold suppresses trailing unknown frames and redundant
 * recognition requests. No unknown photo or attendance is stored.
 * Recognised people use their daily attendance record to prevent duplicates.
 * The camera also waits three seconds after every single-person capture.
 */

/**
 * Long enough to swallow a burst of frames from one moment at the camera, short
 * enough that a genuine retake is not a wait.
 */
export const CAPTURE_WINDOW_MS = 3_000;

/** Bounds the map so a long-running process cannot accumulate keys. */
const MAX_TRACKED = 5_000;

const seenAt = new Map();

function sweep(now) {
  if (seenAt.size < MAX_TRACKED) return;
  for (const [key, expiresAt] of seenAt) {
    if (expiresAt <= now) seenAt.delete(key);
  }
}

/**
 * Whether this tablet is inside its hold.
 *
 * Reading does not extend the window, or a person standing in front of the
 * camera would keep the tablet held for as long as they stayed there.
 */
export function wasRecentlyCaptured(key, { now = Date.now() } = {}) {
  if (!key) return false;
  const expiresAt = seenAt.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    seenAt.delete(key);
    return false;
  }
  return true;
}

/** Starts, or restarts, the hold for this tablet. */
export function rememberCapture(key, { now = Date.now(), windowMs = CAPTURE_WINDOW_MS } = {}) {
  if (!key) return;
  sweep(now);
  seenAt.set(key, now + windowMs);
}

/**
 * Takes the hold if nobody currently owns it.
 *
 * The check and the set run with no await between them, so two overlapping
 * requests in one API process cannot both pass.
 */
export function claimCapture(key, options = {}) {
  if (!key || wasRecentlyCaptured(key, options)) return false;
  rememberCapture(key, options);
  return true;
}

/** The key for a tablet, which is the account signed in on it. */
export function tabletCaptureKey(accountEmail) {
  return `tablet:${accountEmail || "unknown"}`;
}

/** Test seam: the map is process-wide, so a test must be able to clear it. */
export function resetRecentCaptures() {
  seenAt.clear();
}

/**
 * The key for group captures at a tablet, kept apart from the single-person one.
 *
 * The two screens hold for the same reason and must not hold each other: a
 * group photograph and a single check-in are different moments at the camera,
 * and sharing a key would let one silently swallow the other's next frame.
 */
export function groupTabletCaptureKey(accountEmail) {
  return `group:${accountEmail || "unknown"}`;
}
