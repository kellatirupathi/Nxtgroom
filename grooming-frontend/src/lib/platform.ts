export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  const capacitor = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(capacitor?.isNativePlatform?.());
}

export function markNativeShell(): void {
  if (isNativeApp()) document.documentElement.classList.add('native');
}
