import { useCallback, useEffect, useState } from 'react';
import {
  browserFullscreenSupported,
  preferAppFullscreen,
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
  active: boolean;
  browser: boolean;
  supported: boolean;
  offered: boolean;
  enter: () => void;
  exit: () => void;
  decline: () => void;
}

export function useAttendanceFullScreen(): AttendanceFullScreen {
  const [native] = useState(isNativeApp);
  const supported = !native && !preferAppFullscreen() && browserFullscreenSupported();
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
      if (!now) setActive(false);
    };
    FULLSCREEN_CHANGE_EVENTS.forEach((name) => document.addEventListener(name, onChange));
    return () => {
      FULLSCREEN_CHANGE_EVENTS.forEach((name) => document.removeEventListener(name, onChange));
    };
  }, []);

  useEffect(() => () => {
    void leaveBrowserFullscreen();
  }, []);

  const enter = useCallback(() => {
    setOffered(false);
    setActive(true);
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
