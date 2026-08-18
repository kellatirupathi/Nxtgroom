import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The bottom bar is fixed, so it covers whatever sits beneath it. Nothing in
 * the rendered output says how tall it is, which means the space the content
 * reserves and the space the bar occupies can drift apart silently — and when
 * they do, the last row of a table disappears under the icons.
 *
 * These read the source because the suite has no DOM. They cannot prove the
 * pixels line up, but they do catch the two ways this breaks: the numbers
 * being written twice, and the bar and the reservation using different
 * breakpoints.
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

test('the bar height is stated once, where both sides can read it', () => {
  assert.match(css, /--bottom-nav-height:\s*[\d.]+rem/);
  assert.match(css, /--bottom-nav-gap:\s*[\d.]+rem/);
});

test('the scrolling area reserves the bar, the safe area and a gap', () => {
  assert.ok(mainClasses, 'the shell no longer has a <main>; update this test');
  // All three, because any one alone still leaves content under the icons:
  // the bar itself, the home-indicator strip below it, and room to breathe.
  assert.match(mainClasses, /pb-\[calc\(var\(--bottom-nav-height\)/);
  assert.match(mainClasses, /env\(safe-area-inset-bottom\)/);
  assert.match(mainClasses, /var\(--bottom-nav-gap\)/);
});

test('the bar sizes itself from the same variable the reservation uses', () => {
  // A literal height here is how the two drift apart.
  assert.match(nav, /min-h-\[var\(--bottom-nav-height\)\]/);
});

test('the reservation stops exactly where the bar does', () => {
  // The bar is hidden from lg upward, so the reservation must be dropped at
  // the same breakpoint or the desktop layout keeps a strip of dead space.
  assert.match(navBar, /\blg:hidden\b/);
  assert.match(mainClasses, /\blg:pb-6\b/);
});

test('the bar is opaque, so nothing shows through it', () => {
  assert.match(navBar, /\bbg-white\b/);
  // A translucent fill or a blur would let the page read through the bar,
  // which is the appearance this exists to prevent.
  assert.doesNotMatch(navBar, /bg-white\/\d/);
  assert.doesNotMatch(navBar, /backdrop-blur/);
});

test('the bar pads for the safe area rather than sitting under it', () => {
  assert.match(navBar, /pb-\[env\(safe-area-inset-bottom\)\]/);
  assert.match(navBar, /\bfixed\b/);
  assert.match(navBar, /\bbottom-0\b/);
  assert.match(navBar, /\binset-x-0\b/);
});

test('the bar sits below anything meant to cover the screen', () => {
  // Raising the bar instead would only hide more content behind it. Dialogs,
  // photo viewers and portal menus all have to clear it.
  assert.match(navBar, /z-\[var\(--z-bottom-nav\)\]/);
  const navLayer = Number(css.match(/--z-bottom-nav:\s*(\d+)/)?.[1]);
  assert.ok(Number.isFinite(navLayer), 'the bar has no declared layer');

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
    const source = read(file);
    const layers = [...source.matchAll(/z-\[(\d+)\]/g)].map((match) => Number(match[1]));
    assert.ok(layers.length > 0, `${file} declares no layer`);
    for (const layer of layers) {
      assert.ok(layer > navLayer, `${file} sits at ${layer}, at or below the bar's ${navLayer}`);
    }
  }
});

test('the shell is the visible viewport, not the taller vh one', () => {
  // 100vh counts a phone's retracting address bar, which makes the document
  // taller than the screen and lets the fixed bar drift while scrolling.
  assert.match(shell, /h-\[100dvh\]/);
  assert.doesNotMatch(shell, /className="flex h-screen/);
});

test('only the content area scrolls, and it does not drag the page with it', () => {
  assert.match(mainClasses, /\boverflow-auto\b/);
  assert.match(mainClasses, /\boverscroll-contain\b/);
  // The shell itself must not scroll, or there would be two surfaces moving.
  assert.match(shell, /h-\[100dvh\][^"]*overflow-hidden/);
});
