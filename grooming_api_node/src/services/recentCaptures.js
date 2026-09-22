/**
 * A short per-tablet hold, so one moment at the camera is not recorded twice.
 *
 * Recognised people are not held at all. A person who stays in front of the
 * camera after their check-in is photographed again, identified again, and told
 * what their day already holds - "already checked in" or "already checked out" -
 * which records nothing. The daily record is what guarantees one check-in per
 * day, and the tablet waits for each reply before it can fire again, so there
 * is no overlap to guard against. A 45-second hold by name used to sit here; it
 * was removed because a request that failed after claiming it left that person
 * unable to retry, and the tablet silent, for the whole window.
 *
 * What remains is for photographs nobody can be recognised from. They have no
 * name and no daily record to answer with, so each one would otherwise become a
 * separate unidentified check-in. Two cases produce them in bursts: somebody
 * unenrolled standing still, and a recognised person's next frame catching them
 * mid-turn. Both are held briefly per tablet.
 *
 * Deliberately in memory and per replica. The window is a few seconds, and
 * losing it on a restart costs at most one extra unidentified record.
 */

/**
 * Long enough to swallow a burst of frames from one moment at the camera, short
 * enough that a genuine retake is not a wait.
 */
export const UNIDENTIFIED_CAPTURE_WINDOW_MS = 3_000;

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
export function rememberCapture(key, { now = Date.now(), windowMs = UNIDENTIFIED_CAPTURE_WINDOW_MS } = {}) {
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
