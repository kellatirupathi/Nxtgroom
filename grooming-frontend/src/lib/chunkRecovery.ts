const RELOAD_KEY = 'facultytrack:chunk-reload-at';
export const CHUNK_RELOAD_COOLDOWN_MS = 60_000;

export function isChunkLoadError(error: unknown): boolean {
  const name = String((error as { name?: string })?.name || '');
  const message = String((error as { message?: string })?.message || '');
  return name === 'ChunkLoadError'
    || /Failed to fetch dynamically imported module/i.test(message)
    || /error loading dynamically imported module/i.test(message)
    || /Importing a module script failed/i.test(message)
    || /Unable to preload CSS/i.test(message)
    || /Loading chunk [\w-]+ failed/i.test(message);
}

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function reloadForNewDeployment({
  storage = sessionStore(),
  now = Date.now(),
  reload = () => window.location.reload(),
}: { storage?: Storage | null; now?: number; reload?: () => void } = {}): boolean {
  let last = 0;
  try {
    last = Number(storage?.getItem(RELOAD_KEY) || 0);
  } catch {
    last = 0;
  }
  if (Number.isFinite(last) && now - last < CHUNK_RELOAD_COOLDOWN_MS) return false;
  try {
    storage?.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  if (!storage) return false;
  reload();
  return true;
}

export function memoizedImport<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ||= load().catch((error) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}
