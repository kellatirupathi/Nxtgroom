/**
 * Recovering a screen whose code was deployed away while the page was open.
 *
 * Screens that are not needed at first are downloaded when first opened, from
 * files whose names change with every deployment. A tablet left open all day
 * across a deployment asks for yesterday's file, which no longer exists, and
 * the screen fails to open. The fix is always the same - load the page again,
 * which fetches the new file names - so this does that once, by itself.
 *
 * Once, and not again for a minute: a file that is missing for some other
 * reason would otherwise reload the page forever.
 */

const RELOAD_KEY = 'facultytrack:chunk-reload-at';
export const CHUNK_RELOAD_COOLDOWN_MS = 60_000;

/**
 * Whether an error is a screen's code failing to download, as each browser
 * words it, rather than the screen itself going wrong.
 */
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
    // Storage can be refused outright (private mode, blocked site data).
    return null;
  }
}

/**
 * Reloads the page to pick up a new deployment, unless it already did so in
 * the last minute. Returns whether it reloaded.
 */
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
    // Without storage there is no loop guard, so do not reload at all.
    return false;
  }
  if (!storage) return false;
  reload();
  return true;
}

/**
 * A dynamic import that is fetched at most once, but may be tried again.
 *
 * The same promise serves an early preload and the screen that later needs
 * it, so the code is downloaded once. A failed download is forgotten, so the
 * next attempt goes back to the network instead of repeating the failure.
 */
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
