import { useCallback, useEffect, useState } from 'react';
import {
  browserFullscreenSupported,
  declineFullscreen,
  FULLSCREEN_CHANGE_EVENTS,
  fullscreenDeclined,
  inBrowserFullscreen,
  leaveBrowserFullscreen,
  offerFullscreenOnOpen,
  requestBrowserFullscreen,
} from '../lib/attendanceFullscreen';
import { isNativeApp } from '../lib/platform';

export interface AttendanceFullScreen {
  /** The camera covers the window and the app's menus are hidden. */
  active: boolean;
  /** The browser is full screen as well, so its address bar is gone too. */
  browser: boolean;
  /** Whether the browser can hide its own bar: not on iPhone, not in the app. */
  supported: boolean;
  /** The "Start attendance" card is showing, and the camera has not started. */
  offered: boolean;
  /** Call from the tap's own handler; a browser refuses full screen otherwise. */
  enter: () => void;
  exit: () => void;
  decline: () => void;
}

export function useAttendanceFullScreen(): AttendanceFullScreen {
  // The app is already edge to edge, and its web view is not a browser tab
  // whose full screen we can rely on, so there only the menus are hidden.
  const [native] = useState(isNativeApp);
  const supported = !native && browserFullscreenSupported();
  const [browser, setBrowser] = useState(inBrowserFullscreen);
  const [active, setActive] = useState(() => !native && inBrowserFullscreen());
  const [offered, setOffered] = useState(() => offerFullscreenOnOpen({
    native,
    declined: fullscreenDeclined(),
    alreadyFullscreen: inBrowserFullscreen(),
  }));

  useEffect(() => {
    const onChange = () => {
      const now = inBrowserFullscreen();
      setBrowser(now);
      // Esc, the back gesture or the screen sleeping ends it without the
      // close button; the menus come back with the browser's bar.
      if (!now) setActive(false);
    };
    FULLSCREEN_CHANGE_EVENTS.forEach((name) => document.addEventListener(name, onChange));
    return () => {
      FULLSCREEN_CHANGE_EVENTS.forEach((name) => document.removeEventListener(name, onChange));
    };
  }, []);

  // Leaving Attendance by any route must not leave another page full screen
  // with no close button on it.
  useEffect(() => () => {
    void leaveBrowserFullscreen();
  }, []);

  const enter = useCallback(() => {
    setOffered(false);
    setActive(true);
    // A refusal still leaves the menus hidden, which is the most we can do.
    if (supported) void requestBrowserFullscreen();
  }, [supported]);

  const exit = useCallback(() => {
    setActive(false);
    void leaveBrowserFullscreen();
  }, []);

  const decline = useCallback(() => {
    declineFullscreen();
    setOffered(false);
  }, []);

  return { active, browser, supported, offered, enter, exit, decline };
}
