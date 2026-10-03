export const CAPTURE_WINDOW_MS = 3_000;

const MAX_TRACKED = 5_000;

const seenAt = new Map();

function sweep(now) {
  if (seenAt.size < MAX_TRACKED) return;
  for (const [key, expiresAt] of seenAt) {
    if (expiresAt <= now) seenAt.delete(key);
  }
}

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

export function rememberCapture(key, { now = Date.now(), windowMs = CAPTURE_WINDOW_MS } = {}) {
  if (!key) return;
  sweep(now);
  seenAt.set(key, now + windowMs);
}

export function claimCapture(key, options = {}) {
  if (!key || wasRecentlyCaptured(key, options)) return false;
  rememberCapture(key, options);
  return true;
}

export function tabletCaptureKey(accountEmail) {
  return `tablet:${accountEmail || "unknown"}`;
}

export function resetRecentCaptures() {
  seenAt.clear();
}

export function groupTabletCaptureKey(accountEmail) {
  return `group:${accountEmail || "unknown"}`;
}
