import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const css = read('src/index.css');
const shell = read('src/App.tsx');
const nav = read('src/components/BottomNav.tsx');

const mainClasses = [...shell.matchAll(/<main className="([^"]*)"/g)]
  .map((match) => match[1])
  .find((classes) => classes.includes('overflow-auto')) ?? '';
const navBar = nav.match(/aria-label="Primary"\s+className="([^"]*)"/)?.[1] ?? '';

test('the shell is exactly the visible viewport and does not scroll itself', () => {
  assert.match(shell, /h-\[calc\(100dvh-var\(--shell-offset-top\)\)\]/);
  assert.doesNotMatch(shell, /className="flex h-screen/);
  assert.match(shell, /h-\[calc\(100dvh-var\(--shell-offset-top\)\)\][^"]*overflow-hidden/);
});

test('in the app, the shell is a screen tall less the status bar the document pads', () => {
  assert.match(css, /:root\s*\{[^}]*--shell-offset-top:\s*0px/);
  assert.match(css, /\.native\s*\{[^}]*--shell-offset-top:\s*var\(--inset-top\)[^}]*padding-top:\s*var\(--inset-top\)/);
  assert.match(css, /\.native\s*\{[^}]*--inset-top:\s*max\(env\(safe-area-inset-top, 0px\), var\(--safe-area-inset-top, 0px\)\)/);
  assert.match(css, /\.native\s*\{[^}]*--inset-bottom:\s*max\(env\(safe-area-inset-bottom, 0px\), var\(--safe-area-inset-bottom, 0px\)\)/);
});

test('the content area and the bar are rows of one column', () => {
  assert.match(shell, /<div className="flex flex-1 flex-col min-w-0 min-h-0">/);
});

test('the scrolling area takes only the height the bar leaves', () => {
  assert.ok(mainClasses, 'the shell no longer has a scrolling <main>; update this test');
  assert.match(mainClasses, /\bflex-1\b/);
  assert.match(mainClasses, /\bmin-h-0\b/);
  assert.doesNotMatch(mainClasses, /\bh-full\b/);
  assert.match(mainClasses, /\boverflow-auto\b/);
  assert.match(mainClasses, /\boverscroll-contain\b/);
});

test('the content area reserves no space for the bar, because it need not', () => {
  assert.doesNotMatch(mainClasses, /pb-\[calc\(var\(--bottom-nav-height\)/);
  assert.doesNotMatch(mainClasses, /pb-\d{2}/);
});

test('the bar is in the flow, keeps its height, and hides with the sidebar', () => {
  assert.ok(navBar, 'the primary bar was not found; update this test');
  assert.doesNotMatch(navBar, /\bfixed\b/, 'a fixed bar overlays the page again');
  assert.doesNotMatch(navBar, /\babsolute\b/);
  assert.match(navBar, /\bshrink-0\b/);
  assert.match(navBar, /\blg:hidden\b/);
  assert.match(read('src/components/Sidebar.tsx'), /\bhidden lg:flex\b/);
});

test('the bar is opaque and pads the home-indicator strip', () => {
  assert.match(navBar, /\bbg-white\b/);
  assert.doesNotMatch(navBar, /bg-white\/\d/);
  assert.doesNotMatch(navBar, /backdrop-blur/);
  assert.match(navBar, /pb-\[var\(--inset-bottom\)\]/);
  assert.match(css, /:root\s*\{[^}]*--inset-bottom:\s*env\(safe-area-inset-bottom, 0px\)/);
});

test('the bar needs no stacking context now that it is in the flow', () => {
  assert.doesNotMatch(navBar, /\bz-\[/);
  assert.doesNotMatch(navBar, /\bz-\d/);
});

test('the bar height is stated once, where the sheet can read it', () => {
  assert.match(css, /--bottom-nav-height:\s*clamp\([\d.]+rem,[^;]+,\s*[\d.]+rem\)/);
  assert.match(nav, /min-h-\[var\(--bottom-nav-height\)\]/);
  const resting = nav.match(/bottom-\[calc\(var\(--bottom-nav-height\)\+var\(--inset-bottom\)\+1px\)\]/g) || [];
  assert.equal(resting.length, 2, 'the sheet and its backdrop both rest on the bar');
});

test('the bar icons and labels scale with the screen', () => {
  assert.match(css, /--bottom-nav-icon:\s*clamp\(24px,/);
  assert.match(css, /--bottom-nav-label:\s*clamp\(12px,/);
  assert.match(nav, /size-\[var\(--bottom-nav-icon\)\]/);
  assert.match(nav, /text-\[length:var\(--bottom-nav-label\)\]/);
  assert.match(nav, /isActive \? 'bg-indigo-100' : ''/);
});

test('overlays still cover the bar rather than opening behind it', () => {
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
