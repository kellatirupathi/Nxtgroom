export interface Fix {
  latitude: number;
  longitude: number;
  accuracyMetres: number;
  capturedAt: number;
}

export type LocationStatus = 'idle' | 'locating' | 'ready' | 'denied' | 'unavailable';

const CACHE_KEY = 'ft_last_fix';
const MAX_AGE_MS = 5 * 60_000;
const USABLE_ACCURACY_M = 2000;
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
  }
}

function publish(status: LocationStatus): void {
  lastStatus = status;
  for (const notify of subscribers) notify(current, status);
}

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
      publish(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable');
    },
    {
      enableHighAccuracy: true,
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

export function pauseLocationWatch(): void {
  stopWatch();
}

export function resumeLocationWatch(): void {
  if (subscribers.size > 0) startWatch();
}

export function getCachedFix(): Fix | null {
  if (!current) current = readCached();
  return current;
}

export function formatCoordinates(fix: Fix | null): string | null {
  if (!fix) return null;
  if (fix.accuracyMetres > USABLE_ACCURACY_M) return null;
  if (Date.now() - fix.capturedAt > MAX_AGE_MS) return null;
  return `${fix.latitude.toFixed(6)},${fix.longitude.toFixed(6)}`;
}

export async function peekPermission(): Promise<PermissionState | 'unsupported'> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unsupported';
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status.state;
  } catch {
    return 'unsupported';
  }
}

export function describeAccuracy(fix: Fix | null): string | null {
  if (!fix) return null;
  const metres = fix.accuracyMetres;
  if (!metres) return null;
  if (metres < 1000) return `±${metres} m`;
  return `±${(metres / 1000).toFixed(1)} km`;
}
