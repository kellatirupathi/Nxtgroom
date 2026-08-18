import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The bottom bar is a row of the layout, not something painted over the page.
 *
 * The distinction matters. Reserving padding under a fixed bar only adds
 * scrolling room at the end: the content still travels underneath the bar on
 * its way there, which is visible the whole time you scroll. Giving the bar
 * its own row means the scrolling viewport ends where the bar begins, so the
 * two can never occupy the same pixels.
 *
 * These read the source, since the suite has no DOM. They cannot prove the
 * pixels line up, but they do catch the layout collapsing back into an
 * overlay, and the flex rules that quietly break a column of this shape.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const css = read('src/index.css');
const shell = read('src/App.tsx');
const nav = read('src/components/BottomNav.tsx');

// The signed-out screen has a <main> too, so pick the one that scrolls.
const mainClasses = [...shell.matchAll(/<main className="([^"]*)"/g)]
  .map((match) => match[1])
  .find((classes) => classes.includes('overflow-auto')) ?? '';
const navBar = nav.match(/aria-label="Primary"\s+className="([^"]*)"/)?.[1] ?? '';

test('the shell is exactly the visible viewport and does not scroll itself', () => {
  // 100vh counts a phone's retracting address bar, which makes the document
  // taller than the screen and puts the bar off-screen until you scroll.
  assert.match(shell, /h-\[100dvh\]/);
  assert.doesNotMatch(shell, /className="flex h-screen/);
  assert.match(shell, /h-\[100dvh\][^"]*overflow-hidden/);
});

test('the content area and the bar are rows of one column', () => {
  // Siblings in a column is what makes the bar claim real height. If the bar
  // is lifted out of flow again, the page reaches the bottom of the screen
  // and the bar covers whatever ends up there.
  assert.match(shell, /<div className="flex flex-1 flex-col min-w-0 min-h-0">/);
});

test('the scrolling area takes only the height the bar leaves', () => {
  assert.ok(mainClasses, 'the shell no longer has a scrolling <main>; update this test');
  assert.match(mainClasses, /\bflex-1\b/);
  // min-h-0, not h-full: a flex child defaults to refusing to shrink below
  // its content, so without this the column grows past the viewport and the
  // bar is pushed off the bottom of the screen.
  assert.match(mainClasses, /\bmin-h-0\b/);
  assert.doesNotMatch(mainClasses, /\bh-full\b/);
  assert.match(mainClasses, /\boverflow-auto\b/);
  assert.match(mainClasses, /\boverscroll-contain\b/);
});

test('the content area reserves no space for the bar, because it need not', () => {
  // A reservation here would be the old overlay approach returning, and would
  // now leave a strip of dead space above a bar that already has its own.
  assert.doesNotMatch(mainClasses, /pb-\[calc\(var\(--bottom-nav-height\)/);
  assert.doesNotMatch(mainClasses, /pb-\d{2}/);
});

test('the bar is in the flow, keeps its height, and hides with the sidebar', () => {
  assert.ok(navBar, 'the primary bar was not found; update this test');
  assert.doesNotMatch(navBar, /\bfixed\b/, 'a fixed bar overlays the page again');
  assert.doesNotMatch(navBar, /\babsolute\b/);
  // Without shrink-0 a long page squeezes the bar down to nothing.
  assert.match(navBar, /\bshrink-0\b/);
  // The same breakpoint the desktop sidebar appears at, so exactly one of the
  // two navigations is ever present.
  assert.match(navBar, /\blg:hidden\b/);
  assert.match(read('src/components/Sidebar.tsx'), /\bhidden lg:flex\b/);
});

test('the bar is opaque and pads the home-indicator strip', () => {
  assert.match(navBar, /\bbg-white\b/);
  // A translucent fill or a blur would let the page read through the bar.
  assert.doesNotMatch(navBar, /bg-white\/\d/);
  assert.doesNotMatch(navBar, /backdrop-blur/);
  assert.match(navBar, /pb-\[env\(safe-area-inset-bottom\)\]/);
});

test('the bar needs no stacking context now that it is in the flow', () => {
  // Raising a bar above the page only ever hid more content behind it. In the
  // flow there is nothing to raise it above.
  assert.doesNotMatch(navBar, /\bz-\[/);
  assert.doesNotMatch(navBar, /\bz-\d/);
});

test('the bar height is stated once, where the sheet can read it', () => {
  assert.match(css, /--bottom-nav-height:\s*[\d.]+rem/);
  // The bar sizes itself from the variable, and the overflow sheet clears
  // exactly that much when it opens above it.
  assert.match(nav, /min-h-\[var\(--bottom-nav-height\)\]/);
  assert.match(nav, /pb-\[calc\(env\(safe-area-inset-bottom\)\+var\(--bottom-nav-height\)/);
});

test('overlays still cover the bar rather than opening behind it', () => {
  // The sheet and its backdrop are the only parts of the navigation that are
  // still lifted out of flow, and both must sit above a bar that no longer
  // declares a layer of its own.
  for (const file of [
    'src/components/ConfirmDialog.tsx',
    'src/components/PhotoViewer.tsx',
    'src/components/AuditReportModal.tsx',
    'src/components/ForgotPasswordDialog.tsx',
    'src/components/UserPermissionsModal.tsx',
    'src/components/CameraCapture.tsx',
    'src/components/SearchableSelect.tsx',
    'src/components/DateRangeFilter.tsx',
  ]) {
    const layers = [...read(file).matchAll(/z-\[(\d+)\]/g)].map((match) => Number(match[1]));
    assert.ok(layers.length > 0, `${file} declares no layer`);
    for (const layer of layers) {
      assert.ok(layer >= 40, `${file} sits at ${layer}, below the navigation sheet`);
    }
  }
});
