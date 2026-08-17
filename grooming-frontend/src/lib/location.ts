/**
 * Location captured once per session and reused.
 *
 * Asking on every check-in is slow and, on repeat prompts, trains people to
 * dismiss the dialog. A fix is requested once, cached, and refreshed quietly
 * in the background so a submit never waits on the GPS.
 *
 * Accuracy is recorded alongside the coordinates. Browser geolocation ranges
 * from a few metres on GPS to several kilometres on IP lookup, and a reading
 * is only meaningful next to its margin of error.
 */

export interface Fix {
  latitude: number;
  longitude: number;
  /** Radius of 95% confidence, in metres, as reported by the browser. */
  accuracyMetres: number;
  capturedAt: number;
}

export type LocationStatus = 'idle' | 'locating' | 'ready' | 'denied' | 'unavailable';

const CACHE_KEY = 'ft_last_fix';
/** Beyond this a cached fix is treated as stale and refreshed. */
const MAX_AGE_MS = 10 * 60_000;
/** A reading worse than this is too vague to be worth showing as a location. */
const USABLE_ACCURACY_M = 2000;

let current: Fix | null = null;
let inFlight: Promise<Fix | null> | null = null;

function readCached(): Fix | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Fix;
    if (typeof parsed?.latitude !== 'number' || typeof parsed?.longitude !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCached(fix: Fix): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(fix));
  } catch {
    /* Storage may be blocked; the in-memory copy still serves this session. */
  }
}

function isFresh(fix: Fix | null): fix is Fix {
  return Boolean(fix && Date.now() - fix.capturedAt < MAX_AGE_MS);
}

/** Last known fix without triggering a permission prompt. */
export function getCachedFix(): Fix | null {
  if (!current) current = readCached();
  return current;
}

/** "12.9716,77.5946" for submission, or null when no usable fix exists. */
export function formatCoordinates(fix: Fix | null): string | null {
  if (!fix) return null;
  if (fix.accuracyMetres > USABLE_ACCURACY_M) return null;
  return `${fix.latitude.toFixed(6)},${fix.longitude.toFixed(6)}`;
}

/**
 * Requests a fix, reusing an in-flight request so several callers on one
 * screen cannot stack permission prompts.
 */
export function requestFix({ force = false } = {}): Promise<Fix | null> {
  const cached = getCachedFix();
  if (!force && isFresh(cached)) return Promise.resolve(cached);
  if (inFlight) return inFlight;

  inFlight = new Promise<Fix | null>((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const fix: Fix = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMetres: Math.round(position.coords.accuracy ?? 0),
          capturedAt: Date.now(),
        };
        current = fix;
        writeCached(fix);
        resolve(fix);
      },
      () => {
        // Denied, timed out, or unavailable: fall back to whatever we hold so
        // a stale-but-real position still beats no position at all.
        resolve(getCachedFix());
      },
      {
        enableHighAccuracy: true,
        // Generous, because a cold GPS lock outdoors can take this long. The
        // caller never blocks on it, so a slow fix costs the user nothing.
        timeout: 15_000,
        maximumAge: MAX_AGE_MS,
      },
    );
  }).finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** Reports the permission state without prompting, where the browser supports it. */
export async function peekPermission(): Promise<PermissionState | 'unsupported'> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unsupported';
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status.state;
  } catch {
    return 'unsupported';
  }
}

/** Human-readable accuracy for the UI, so a vague fix is visibly vague. */
export function describeAccuracy(fix: Fix | null): string | null {
  if (!fix) return null;
  const metres = fix.accuracyMetres;
  if (!metres) return null;
  if (metres < 1000) return `±${metres} m`;
  return `±${(metres / 1000).toFixed(1)} km`;
}
