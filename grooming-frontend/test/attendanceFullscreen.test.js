import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  browserFullscreenSupported,
  declineFullscreen,
  FULLSCREEN_CHANGE_EVENTS,
  FULLSCREEN_DECLINED_KEY,
  fullscreenDeclined,
  inBrowserFullscreen,
  leaveBrowserFullscreen,
  offerFullscreenOnOpen,
  requestBrowserFullscreen,
} from '../src/lib/attendanceFullscreen.ts';

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('full screen is supported through the standard or the webkit flag only', () => {
  assert.equal(browserFullscreenSupported({ fullscreenEnabled: true }), true);
  assert.equal(browserFullscreenSupported({ webkitFullscreenEnabled: true }), true);
  // iPhone Safari: neither flag.
  assert.equal(browserFullscreenSupported({}), false);
  assert.equal(browserFullscreenSupported(null), false);
});

test('in full screen means some element holds it, under either name', () => {
  const element = {};
  assert.equal(inBrowserFullscreen({ fullscreenElement: element }), true);
  assert.equal(inBrowserFullscreen({ webkitFullscreenElement: element }), true);
  assert.equal(inBrowserFullscreen({ fullscreenElement: null }), false);
  assert.equal(inBrowserFullscreen(null), false);
  assert.deepEqual([...FULLSCREEN_CHANGE_EVENTS], ['fullscreenchange', 'webkitfullscreenchange']);
});

test('the request asks Android Chrome to hide its bar and reports whether it was granted', async () => {
  const calls = [];
  const granted = await requestBrowserFullscreen({
    requestFullscreen: async (options) => { calls.push(options); },
  });
  assert.equal(granted, true);
  assert.deepEqual(calls, [{ navigationUI: 'hide' }]);

  const refused = await requestBrowserFullscreen({
    requestFullscreen: async () => { throw new TypeError('Permissions check failed'); },
  });
  assert.equal(refused, false);
});

test('the request is made before anything is awaited, so the tap still counts', () => {
  let asked = false;
  const pending = requestBrowserFullscreen({
    requestFullscreen: () => { asked = true; return new Promise(() => {}); },
  });
  assert.equal(asked, true);
  assert.ok(pending instanceof Promise);
});

test('older Safari is asked through the webkit call, and nothing at all is refused', async () => {
  let asked = 0;
  assert.equal(await requestBrowserFullscreen({ webkitRequestFullscreen: () => { asked += 1; } }), true);
  assert.equal(asked, 1);
  assert.equal(await requestBrowserFullscreen({}), false);
  assert.equal(await requestBrowserFullscreen(null), false);
});

test('leaving only calls the browser when it is actually full screen', async () => {
  let exits = 0;
  await leaveBrowserFullscreen({ fullscreenElement: null, exitFullscreen: async () => { exits += 1; } });
  assert.equal(exits, 0);

  await leaveBrowserFullscreen({ fullscreenElement: {}, exitFullscreen: async () => { exits += 1; } });
  assert.equal(exits, 1);

  await leaveBrowserFullscreen({ webkitFullscreenElement: {}, webkitExitFullscreen: () => { exits += 1; } });
  assert.equal(exits, 2);

  // Esc got there first: the browser rejects, and that is not an error here.
  await leaveBrowserFullscreen({ fullscreenElement: {}, exitFullscreen: async () => { throw new TypeError('Document not active'); } });
});

test('"Not now" is remembered for the tab, and a broken storage never throws', () => {
  const storage = memoryStorage();
  assert.equal(fullscreenDeclined(storage), false);
  declineFullscreen(storage);
  assert.equal(storage.getItem(FULLSCREEN_DECLINED_KEY), '1');
  assert.equal(fullscreenDeclined(storage), true);

  const broken = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  assert.equal(fullscreenDeclined(broken), false);
  assert.doesNotThrow(() => declineFullscreen(broken));
  assert.equal(fullscreenDeclined(null), false);
});

test('the start card shows in a browser that has not declined and is not already full screen', () => {
  assert.equal(offerFullscreenOnOpen({ native: false, declined: false, alreadyFullscreen: false }), true);
  assert.equal(offerFullscreenOnOpen({ native: false, declined: true, alreadyFullscreen: false }), false);
  assert.equal(offerFullscreenOnOpen({ native: false, declined: false, alreadyFullscreen: true }), false);
  // The Android app has no address bar: it opens on the camera as before.
  assert.equal(offerFullscreenOnOpen({ native: true, declined: false, alreadyFullscreen: false }), false);
});

test('the attendance screen offers full screen, closes it behind a question, and keeps one camera element', () => {
  const screen = source('components/AttendanceScreen.tsx');
  for (const text of [
    'Start attendance',
    'Start full screen',
    'Not now',
    'Full screen',
    'aria-label="Exit full screen"',
    'Exit full screen?',
    'cancelLabel="Stay in full screen"',
    'confirmLabel="Exit"',
    'Esc also exits',
  ]) {
    assert.ok(screen.includes(text), `missing ${text}`);
  }
  // Over the whole window, above the bottom bar's sheet (z-46) and below every
  // dialog (z-60 and up), so a confirmation or a toast still shows on top.
  assert.match(screen, /'fixed inset-0 z-\[55\] flex flex-col bg-slate-950/);
  // Out of full screen the element keeps the classes it always had.
  assert.match(screen, /: 'w-full h-full flex flex-col'\}/);
  // One element restyled, not two trees: the camera must not restart.
  assert.equal(screen.match(/<KioskAttendance onExit=\{onExit\} \/>/g).length, 1);
  assert.equal(screen.match(/<GroupScreen \/>/g).length, 1);
});

test('the full-screen switch lives in its own hook and leaves full screen when the screen goes', () => {
  const hook = source('components/useAttendanceFullScreen.ts');
  assert.match(hook, /FULLSCREEN_CHANGE_EVENTS\.forEach\(\(name\) => document\.addEventListener\(name, onChange\)\)/);
  assert.match(hook, /if \(!now\) setActive\(false\)/);
  assert.match(hook, /useEffect\(\(\) => \(\) => \{\s*void leaveBrowserFullscreen\(\);\s*\}, \[\]\)/);
  // The app's web view is never asked; only its menus are hidden.
  assert.match(hook, /const supported = !native && browserFullscreenSupported\(\)/);
});

test('both camera screens only change colour in full screen', () => {
  for (const file of ['components/KioskAttendance.tsx', 'components/GroupKioskAttendance.tsx']) {
    const screen = source(file);
    assert.match(screen, /const fullScreen = useContext\(AttendanceFullScreenContext\)/, file);
    assert.match(screen, /fullScreen \? 'text-white' : 'text-slate-800'/, file);
    assert.match(screen, /fullScreen \? 'text-slate-300' : 'text-slate-500'/, file);
    assert.match(screen, /fullScreen \? 'border-slate-800' : 'border-slate-200'/, file);
  }
});

test('the app shell is untouched: full screen is entirely inside the Attendance screen', () => {
  const app = source('App.tsx');
  assert.ok(!/fullscreen/i.test(app));
  assert.match(app, /<AttendanceScreen onExit=\{\(\) => navigate\('daily-records'\)\} \/>/);
});
