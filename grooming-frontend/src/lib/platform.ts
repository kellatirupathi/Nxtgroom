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
