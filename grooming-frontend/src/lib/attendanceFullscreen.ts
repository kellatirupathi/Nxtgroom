import { createContext } from 'react';

/**
 * Full screen for the Attendance screen. A browser only goes full screen from
 * a tap, so the screen asks when it opens. iPhone Safari has no full screen for
 * a page and the Android app has no address bar to hide; there full screen only
 * hides the app's own menus.
 */

/** The standard names plus the webkit ones older Safari and iPadOS still use. */
export interface FullscreenDocument {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
}

export interface FullscreenTarget {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  webkitRequestFullscreen?: () => void;
}

export const FULLSCREEN_CHANGE_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'] as const;

/** Remembered for the tab, so coming back to Attendance does not ask again. */
export const FULLSCREEN_DECLINED_KEY = 'attendance-fullscreen-declined';

/** True while the screen is on, so the two camera screens can suit a dark background. */
export const AttendanceFullScreenContext = createContext(false);

function currentDocument(): FullscreenDocument | null {
  return typeof document === 'undefined' ? null : (document as unknown as FullscreenDocument);
}

export function browserFullscreenSupported(doc: FullscreenDocument | null = currentDocument()): boolean {
  return Boolean(doc && (doc.fullscreenEnabled || doc.webkitFullscreenEnabled));
}

export function inBrowserFullscreen(doc: FullscreenDocument | null = currentDocument()): boolean {
  return Boolean(doc && (doc.fullscreenElement || doc.webkitFullscreenElement));
}

/**
 * Must run inside the tap's handler: the request is made before the first
 * await, which is what keeps it counted as the user's own action. Resolves to
 * whether the browser agreed; a refusal leaves only the menus hidden.
 */
export async function requestBrowserFullscreen(target: FullscreenTarget | null = typeof document === 'undefined'
  ? null
  : document.documentElement): Promise<boolean> {
  if (!target) return false;
  try {
    if (target.requestFullscreen) {
      // Android Chrome otherwise keeps a bar at the top for leaving.
      await target.requestFullscreen({ navigationUI: 'hide' });
      return true;
    }
    if (target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
      return true;
    }
  } catch {
    // Refused: an iframe without permission, or no tap behind the request.
  }
  return false;
}

export async function leaveBrowserFullscreen(doc: FullscreenDocument | null = currentDocument()): Promise<void> {
  if (!doc || !inBrowserFullscreen(doc)) return;
  try {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else doc.webkitExitFullscreen?.();
  } catch {
    // Already left, by Esc or the back gesture, between the check and the call.
  }
}

type ReadStorage = Pick<Storage, 'getItem'> | null | undefined;
type WriteStorage = Pick<Storage, 'setItem'> | null | undefined;

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function fullscreenDeclined(storage: ReadStorage = sessionStore()): boolean {
  try {
    return storage?.getItem(FULLSCREEN_DECLINED_KEY) === '1';
  } catch {
    return false;
  }
}

export function declineFullscreen(storage: WriteStorage = sessionStore()): void {
  try {
    storage?.setItem(FULLSCREEN_DECLINED_KEY, '1');
  } catch {
    // Private mode: the question comes back next time, which is harmless.
  }
}

/**
 * Whether the screen opens on the "Start attendance" card. The app has no
 * address bar to hide, so it opens straight on the camera as it always has.
 */
export function offerFullscreenOnOpen({ native, declined, alreadyFullscreen }: {
  native: boolean;
  declined: boolean;
  alreadyFullscreen: boolean;
}): boolean {
  return !native && !declined && !alreadyFullscreen;
}
