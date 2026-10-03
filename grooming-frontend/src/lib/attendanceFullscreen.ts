import { createContext } from 'react';

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

export const FULLSCREEN_DECLINED_KEY = 'attendance-fullscreen-declined';

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

export async function requestBrowserFullscreen(target: FullscreenTarget | null = typeof document === 'undefined'
  ? null
  : document.documentElement): Promise<boolean> {
  if (!target) return false;
  try {
    if (target.requestFullscreen) {
      await target.requestFullscreen({ navigationUI: 'hide' });
      return true;
    }
    if (target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
      return true;
    }
  } catch {
  }
  return false;
}

export async function leaveBrowserFullscreen(doc: FullscreenDocument | null = currentDocument()): Promise<void> {
  if (!doc || !inBrowserFullscreen(doc)) return;
  try {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else doc.webkitExitFullscreen?.();
  } catch {
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
  }
}

export function offerFullscreenOnOpen({ native, declined, alreadyFullscreen }: {
  native: boolean;
  declined: boolean;
  alreadyFullscreen: boolean;
}): boolean {
  return !native && !declined && !alreadyFullscreen;
}


export function preferAppFullscreen(device: { userAgent?: string; platform?: string; maxTouchPoints?: number } | null = typeof navigator === 'undefined' ? null : navigator): boolean {
  return Boolean(device && (
    /iPad|iPhone|iPod/.test(device.userAgent || '')
    || (device.platform === 'MacIntel' && (device.maxTouchPoints || 0) > 1)
  ));
}
