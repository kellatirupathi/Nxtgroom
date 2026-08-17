/**
 * Live location for attendance.
 *
 * The browser is subscribed with watchPosition while the check-in screen is
 * open, so the position follows the device rather than being sampled once and
 * cached. That matters because the coordinates are evidence of where someone
 * was at check-in: an instructor who moves to another campus must not be
 * recorded at the previous one.
 *
 * Permission is still requested only once — the browser remembers it, and
 * subscribing afterwards never prompts again.
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
/** Beyond this a stored fix is too old to submit. */
const MAX_AGE_MS = 5 * 60_000;
/** A reading worse than this is too vague to record as a location. */
const USABLE_ACCURACY_M = 2000;
/**
 * How long a fix stays authoritative against a less accurate update. GPS
 * jitters: a good fix is often followed by a worse one from the same spot, and
 * replacing it would throw away the better reading for no reason.
 */
const PREFER_ACCURATE_WINDOW_MS = 30_000;

let current: Fix | null = null;
let watchId: number | null = null;
let lastStatus: LocationStatus = 'idle';
const subscribers = new Set<(fix: Fix | null, status: LocationStatus) => void>();

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
    /* Storage may be blocked; the in-memory fix still serves this session. */
  }
}

function publish(status: LocationStatus): void {
  lastStatus = status;
  for (const notify of subscribers) notify(current, status);
}

/**
 * Decides whether an incoming reading replaces the one held.
 *
 * Accepts a better reading immediately, and a worse one only once the held fix
 * has aged out — otherwise ordinary GPS noise would repeatedly downgrade a
 * good position while the device sits still.
 */
function shouldReplace(next: Fix): boolean {
  if (!current) return true;
  if (next.accuracyMetres <= current.accuracyMetres) return true;
  return next.capturedAt - current.capturedAt > PREFER_ACCURATE_WINDOW_MS;
}

function toFix(position: GeolocationPosition): Fix {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyMetres: Math.round(position.coords.accuracy ?? 0),
    capturedAt: Date.now(),
  };
}

/**
 * Subscribes to position updates and starts the watch if it is not running.
 * Returns an unsubscribe function; the watch stops once nobody is listening.
 */
export function subscribeToLocation(
  listener: (fix: Fix | null, status: LocationStatus) => void,
): () => void {
  subscribers.add(listener);
  if (!current) current = readCached();
  listener(current, lastStatus);
  startWatch();

  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) stopWatch();
  };
}

function startWatch(): void {
  if (watchId !== null) return;
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    publish('unavailable');
    return;
  }
  publish(current ? 'ready' : 'locating');

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const next = toFix(position);
      if (!shouldReplace(next)) return;
      current = next;
      writeCached(next);
      publish('ready');
    },
    (error) => {
      // PERMISSION_DENIED is terminal: no retry recovers it, the user must
      // change it in browser settings, so say so rather than spinning.
      publish(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable');
    },
    {
      enableHighAccuracy: true,
      // Zero, deliberately. A non-zero maximumAge lets the browser answer with
      // a position from a previous location, which is exactly the staleness
      // this replaces.
      maximumAge: 0,
      timeout: 20_000,
    },
  );
}

function stopWatch(): void {
  if (watchId === null) return;
  if (typeof navigator !== 'undefined' && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
  }
  watchId = null;
}

/** Pauses the watch while the tab is hidden, so it costs no battery in the background. */
export function pauseLocationWatch(): void {
  stopWatch();
}

export function resumeLocationWatch(): void {
  if (subscribers.size > 0) startWatch();
}

/** Last known fix without triggering a permission prompt. */
export function getCachedFix(): Fix | null {
  if (!current) current = readCached();
  return current;
}

/**
 * "12.9716,77.5946" for submission, or null when nothing usable is held.
 * A fix that is too old or too vague is withheld rather than submitted, since
 * a wrong location is worse than none.
 */
export function formatCoordinates(fix: Fix | null): string | null {
  if (!fix) return null;
  if (fix.accuracyMetres > USABLE_ACCURACY_M) return null;
  if (Date.now() - fix.capturedAt > MAX_AGE_MS) return null;
  return `${fix.latitude.toFixed(6)},${fix.longitude.toFixed(6)}`;
}

/** Reports the permission state without prompting, where supported. */
export async function peekPermission(): Promise<PermissionState | 'unsupported'> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unsupported';
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status.state;
  } catch {
    return 'unsupported';
  }
}

/** Human-readable accuracy, so a vague fix is visibly vague. */
export function describeAccuracy(fix: Fix | null): string | null {
  if (!fix) return null;
  const metres = fix.accuracyMetres;
  if (!metres) return null;
  if (metres < 1000) return `±${metres} m`;
  return `±${(metres / 1000).toFixed(1)} km`;
}
