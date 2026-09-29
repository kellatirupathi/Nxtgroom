import test from 'node:test';
import assert from 'node:assert/strict';
import {
  complianceChange,
  formatCount,
  formatPercent,
  shortDayLabel,
  sortInstitutes,
  weekdayLabel,
} from '../src/dashboardFormat.ts';

test('day keys format as the calendar date they name, in any viewer time zone', () => {
  // A key parsed as local midnight moves back a day west of UTC; these are
  // read as UTC calendar dates so 29 September stays 29 September.
  assert.match(shortDayLabel('2026-09-29'), /29 Sep/);
  assert.match(shortDayLabel('2026-09-14'), /14 Sep/);
  assert.equal(weekdayLabel('2026-09-22'), 'Tuesday');
  assert.equal(shortDayLabel('not-a-day'), 'not-a-day');
});

test('percentages and counts', () => {
  assert.equal(formatPercent(84.5), '84.5%');
  assert.equal(formatPercent(100), '100.0%');
  assert.equal(formatPercent(null), '—');
  assert.equal(formatCount(1184), '1,184');
  assert.equal(formatCount(125000), '1,25,000');
});

test('compliance change against the same weekday last week', () => {
  assert.deepEqual(complianceChange(84.5, 81.3), { points: 3.2, direction: 'up' });
  assert.deepEqual(complianceChange(70, 75), { points: -5, direction: 'down' });
  assert.deepEqual(complianceChange(80, 80), { points: 0, direction: 'flat' });
  assert.equal(complianceChange(80, null), null);
  assert.equal(complianceChange(null, 80), null);
});

const institute = (name, extra) => ({
  college_id: name,
  name,
  mode: 'FACE_ONLY',
  present: 0,
  instructors: 0,
  present_percent: null,
  compliant: 0,
  non_compliant: 0,
  compliance_percent: null,
  unidentified: 0,
  enrolled: 0,
  enrolled_percent: 0,
  low_enrolment: false,
  ...extra,
});

test('institutes sort with missing values last in both directions', () => {
  const rows = [
    institute('Coimbatore', { present_percent: 90 }),
    institute('Empty', {}),
    institute('Anantapur', { present_percent: 60 }),
    institute('Bidar', { present_percent: 60 }),
  ];
  const ascending = sortInstitutes(rows, { key: 'present_percent', direction: 1 }).map((row) => row.name);
  assert.deepEqual(ascending, ['Anantapur', 'Bidar', 'Coimbatore', 'Empty']);
  const descending = sortInstitutes(rows, { key: 'present_percent', direction: -1 }).map((row) => row.name);
  assert.deepEqual(descending, ['Coimbatore', 'Anantapur', 'Bidar', 'Empty']);
  const byName = sortInstitutes(rows, { key: 'name', direction: -1 }).map((row) => row.name);
  assert.deepEqual(byName, ['Empty', 'Coimbatore', 'Bidar', 'Anantapur']);
  assert.notEqual(sortInstitutes(rows, { key: 'name', direction: 1 }), rows, 'the input is not mutated');
});
