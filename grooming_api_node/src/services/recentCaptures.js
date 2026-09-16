/**
 * Who was photographed a moment ago, so the same person is not recorded twice.
 *
 * The kiosk camera fires five times a second. Something has to stop one person
 * standing in front of it from being photographed on every frame, because each
 * one costs a recognition call, a vision call and a stored object.
 *
 * That job used to belong to an eight-second cooldown in the browser, which
 * blocked the camera outright. It worked, but it could not tell a person
 * lingering from the next person in the queue, so a queue moved at one person
 * every nine seconds to solve a problem caused by one person not moving.
 *
 * Remembering who was seen is both faster and stricter. A different face fires
 * immediately; the same face is refused for the whole window, rather than being
 * free to fire again the moment an arbitrary timer expired.
 *
 * Deliberately in memory. The window is under a minute, the entries are
 * worthless after it, and a restart losing them costs one duplicate refusal at
 * most. Per replica, so two API instances each hold their own view: with a
 * single tablet per college talking to one connection at a time, the same
 * person reaching two replicas inside the window is not a case worth a shared
 * store. The daily record is what actually guarantees one check-in per day.
 */

/** Long enough to cover somebody lingering after their photo was taken. */
export const RECENT_CAPTURE_WINDOW_MS = 45_000;

/**
 * Unidentified captures have no instructor to remember, so they are held per
 * tablet instead. Shorter, because it blocks a real person from trying again:
 * long enough to stop a burst, short enough that a retake is not a wait.
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
 * Whether this subject was already recorded inside its window.
 *
 * Reading does not extend the window. Somebody who stands in front of the
 * camera for a full minute is refused for the first window and then genuinely
 * reconsidered, rather than being locked out for as long as they keep standing
 * there — which would turn a duplicate guard into a way of never checking out.
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

/** Records that this subject has just been captured. */
export function rememberCapture(key, { now = Date.now(), windowMs = RECENT_CAPTURE_WINDOW_MS } = {}) {
  if (!key) return;
  sweep(now);
  seenAt.set(key, now + windowMs);
}

/** The key for a recognised instructor. Scoped per college, matching the record. */
export function instructorCaptureKey(collegeId, instructorId) {
  return `instructor:${collegeId || "none"}:${instructorId}`;
}

/** The key for an unrecognised capture, which can only be held per tablet. */
export function tabletCaptureKey(accountEmail) {
  return `tablet:${accountEmail || "unknown"}`;
}

/** Test seam: the map is process-wide, so a test must be able to clear it. */
export function resetRecentCaptures() {
  seenAt.clear();
}
