import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('Settings lists its sections in the side menu, with Holidays, Config and a super-admin-only Audit log', () => {
  const page = read('components/SettingsPage.tsx');
  assert.match(read('routes.ts'), /export type SettingsTab = [^;]*'config' \| 'audit';/);
  const tabs = [...page.matchAll(/\{ tab: '([a-z]+)', label: '([^']+)'/g)].map((match) => `${match[1]}:${match[2]}`);
  assert.deepEqual(tabs, [
    'notifications:Notifications', 'identification:Identification', 'colleges:Institutes', 'sync:Sync Data',
    'rp:RP', 'reports:Reports', 'holidays:Holidays', 'config:Config', 'audit:Audit log',
  ]);
  assert.ok(page.includes("{ tab: 'audit', label: 'Audit log', icon: History, rootOnly: true }"));
  assert.ok(page.includes("SECTIONS.filter((section) => !section.rootOnly || role === 'SUPER_ADMIN')"));
  assert.ok(page.includes("{tab === 'config' && <ConfigSettingsSection />}"));
  assert.ok(page.includes("{tab === 'holidays' && <HolidaySettings />}"));
  assert.ok(page.includes("{tab === 'audit' && <AuditLogSection />}"));
  assert.ok(read('App.tsx').includes('<SettingsPage role={session.role} />'));
});

test('Holidays and the audit log talk to their settings endpoints', () => {
  const holidays = read('components/HolidaySettings.tsx');
  assert.ok(holidays.includes("const PATH = '/api/v2/settings/holidays';"));
  assert.ok(holidays.includes("apiJson<Holiday[]>(PATH, { method: 'POST', body: { date, name: name.trim() } })"));
  assert.ok(holidays.includes("`${PATH}/${encodeURIComponent(removing.date)}`, { method: 'DELETE' }"));
  const audit = read('components/AuditLogSection.tsx');
  assert.ok(audit.includes("const PATH = '/api/v2/settings/audit-log';"));
  for (const label of ['Logins', 'Created', 'Edited', 'Deleted', 'Settings changes']) assert.ok(audit.includes(`label: '${label}'`), label);
});

test('the Config tab has the switch for moving a checked-in instructor, saved to the server', () => {
  const section = read('components/ConfigSettingsSection.tsx');
  assert.ok(section.includes("const CONFIG_PATH = '/api/v2/settings/config';"));
  assert.ok(section.includes('Allow moving a checked-in instructor to another institute'));
  assert.match(section, /<Toggle\s+id="allow_move_while_checked_in"\s+checked=\{settings\.allow_move_while_checked_in\}/);
  assert.match(section, /method: 'PUT',\s*body: \{ \[key\]: value \},/);
  assert.ok(section.includes("useState<ConfigSettings>({ allow_move_while_checked_in: false })"), 'off until loaded');
});
