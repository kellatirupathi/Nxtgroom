import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('Settings has a Config tab, last, that shows the config section', () => {
  const page = read('components/SettingsPage.tsx');
  assert.match(read('routes.ts'), /export type SettingsTab = [^;]*'config';/);
  const tabs = [...page.matchAll(/aria-selected=\{tab === '([a-z]+)'\}/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['notifications', 'identification', 'colleges', 'sync', 'rp', 'reports', 'config']);
  assert.match(page, /<SlidersHorizontal size=\{16\} aria-hidden="true" \/>\s*Config\s*<\/button>/);
  assert.ok(page.includes("{tab === 'config' && <ConfigSettingsSection />}"));
});

test('the Config tab has the switch for moving a checked-in instructor, saved to the server', () => {
  const section = read('components/ConfigSettingsSection.tsx');
  assert.ok(section.includes("const CONFIG_PATH = '/api/v2/settings/config';"));
  assert.ok(section.includes('Allow moving a checked-in instructor to another institute'));
  assert.match(section, /<Toggle\s+id="allow_move_while_checked_in"\s+checked=\{settings\.allow_move_while_checked_in\}/);
  assert.match(section, /method: 'PUT',\s*body: \{ \[key\]: value \},/);
  assert.ok(section.includes("useState<ConfigSettings>({ allow_move_while_checked_in: false })"), 'off until loaded');
});
