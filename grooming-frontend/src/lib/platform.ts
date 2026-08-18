/**
 * Whether the app is running inside the Capacitor Android shell rather than a
 * browser. Capacitor injects this global, so no plugin import is needed and
 * the check costs nothing on the web.
 */
export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  const capacitor = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(capacitor?.isNativePlatform?.());
}

/**
 * Tags the document so app-only styling in index.css can apply. Called once at
 * startup; on the web it does nothing, so the site is unaffected.
 */
export function markNativeShell(): void {
  if (isNativeApp()) document.documentElement.classList.add('native');
}
