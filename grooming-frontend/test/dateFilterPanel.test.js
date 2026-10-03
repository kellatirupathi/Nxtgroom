import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { floatingPanelPosition } from '../src/lib/floatingPanel.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the menu opens under its button', () => {
  assert.deepEqual(
    floatingPanelPosition({ bottom: 320, left: 1466 }, 256, 1917),
    { top: 326, left: 1466 },
    'the filter panel case from the report: fits, so it sits exactly under the button',
  );
});

test('a menu that would run off the right edge is pulled back on screen', () => {
  const { left } = floatingPanelPosition({ bottom: 100, left: 1800 }, 256, 1917);
  assert.equal(left, 1917 - 256 - 8);
});

test('a menu is never pushed past the left edge either', () => {
  assert.equal(floatingPanelPosition({ bottom: 100, left: -30 }, 256, 1917).left, 8);
  assert.equal(floatingPanelPosition({ bottom: 100, left: 20 }, 256, 240).left, 8);
});

test('the position is set in the same click that opens the menu, before it is drawn', () => {
  const source = read('src/components/DateRangeFilter.tsx');
  const toggle = source.slice(source.indexOf('const togglePanel = () => {'));
  const measured = toggle.indexOf('place();');
  const opened = toggle.indexOf('setOpen(true);');
  assert.ok(measured > 0 && measured < opened, 'measure first, then open - never the other way round');
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*if \(!open\) return undefined;/);
  assert.ok(!/\buseEffect\(/.test(source), 'no positioning left in a post-paint effect');
});
