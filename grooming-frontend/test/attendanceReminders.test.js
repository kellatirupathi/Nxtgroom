import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('Notifications has a check-in missed and a check-out missed email, each with its own time, both off until turned on', () => {
  const settings = read('components/SettingsPage.tsx');
  assert.match(settings, /their own switch\.\s*<\/p>\s*<AttendanceReminderSettings \/>\s*<AccessSettingsSection \/>/);
  const section = read('components/AttendanceReminderSettings.tsx');
  assert.ok(section.includes("const PATH = '/api/v2/settings/attendance-reminders';"));
  assert.ok(section.includes("label: 'Check-in missed email'"));
  assert.ok(section.includes("label: 'Check-out missed email'"));
  assert.ok(section.includes('checkin_reminder_enabled: false,'), 'off until loaded');
  assert.ok(section.includes('checkout_reminder_enabled: false,'));
  assert.ok(section.includes("? { [`${kind}_reminder_enabled`]: true, [`${kind}_reminder_time`]: draft }"), 'turning on saves the time shown');
  assert.ok(section.includes("onClick={() => void save({ [`${kind}_reminder_time`]: draft })}"), 'the time is saved on its own');
  assert.ok(section.includes('Send at'));
});
