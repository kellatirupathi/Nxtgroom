import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ESCALATION_FILTER_OPTIONS,
  escalationLabel,
  filterAttendanceRecords,
  spreadEscalation,
  weekStartOf,
} from '../src/attendanceFilters.ts';
import { attendanceCsv } from '../src/attendanceExport.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * The Escalation column on Daily Records.
 *
 * The server says who is escalated - three or more non-compliant results in a
 * Monday-to-Sunday week, counted the same way as the URGENT email. These tests
 * hold the page to showing it: in one line, on every row of that week, through
 * the filter, and in the export.
 */

const WEEK = { week_start: '2026-09-21', week_end: '2026-09-27', count: 3 };

test('weeks start on Monday, as they do on the server', () => {
  assert.equal(weekStartOf('2026-09-21'), '2026-09-21', 'Monday');
  assert.equal(weekStartOf('2026-09-25'), '2026-09-21', 'Friday');
  assert.equal(weekStartOf('2026-09-27'), '2026-09-21', 'Sunday closes the week');
  assert.equal(weekStartOf('2026-09-28'), '2026-09-28', 'the next Monday starts a new one');
  assert.equal(weekStartOf('2026-01-01'), '2025-12-29', 'across a year end');
});

test('one short line, with the dates behind it', () => {
  const label = escalationLabel(WEEK, '2026-09-25');
  assert.equal(label.text, 'Escalated · 3× this week');
  assert.equal(label.title, 'Escalated: non-compliant 3 times in the week of Sep 21 - Sep 27, 2026');
  assert.equal(escalationLabel({ ...WEEK, count: 5 }, '2026-09-25').text, 'Escalated · 5× this week');
});

test('a row from an earlier week does not claim to be this week', () => {
  assert.equal(escalationLabel(WEEK, '2026-10-02').text, 'Escalated · 3× that week');
});

test('fewer than three, or nothing, shows nothing', () => {
  assert.equal(escalationLabel(null, '2026-09-25'), null);
  assert.equal(escalationLabel(undefined, '2026-09-25'), null);
  assert.equal(escalationLabel({ ...WEEK, count: 2 }, '2026-09-25'), null);
});

const rows = [
  { _id: 'mon', instructor_id: 'i1', instructor_name: 'Ravi', attendance_day: '2026-09-21', status: 'non_compliant', updated_at: '2026-09-21T04:00:00Z', escalation: null },
  { _id: 'fri', instructor_id: 'i1', instructor_name: 'Ravi', attendance_day: '2026-09-25', status: 'non_compliant', updated_at: '2026-09-25T04:05:00Z', escalation: WEEK },
  { _id: 'asha', instructor_id: 'i2', instructor_name: 'Asha', attendance_day: '2026-09-25', status: 'compliant', updated_at: '2026-09-25T04:00:00Z', escalation: null },
  { _id: 'lastweek', instructor_id: 'i1', instructor_name: 'Ravi', attendance_day: '2026-09-19', status: 'compliant', updated_at: '2026-09-19T04:00:00Z', escalation: null },
  { _id: 'unknown', instructor_id: null, attendance_day: '2026-09-25', status: 'unidentified', escalation: null },
];

test('a refresh that brings the escalation marks the earlier rows of that week', () => {
  // The table refreshes by fetching only changed rows: Friday's row arrives
  // escalated, Monday's was fetched on Monday and is not fetched again.
  const spread = spreadEscalation(rows);
  const byId = Object.fromEntries(spread.map((row) => [row._id, row]));
  assert.deepEqual(byId.mon.escalation, WEEK, "Monday's row joins Friday's escalation");
  assert.equal(byId.lastweek.escalation, null, 'last week is its own week');
  assert.equal(byId.asha.escalation, null, 'another instructor is untouched');
  assert.equal(byId.unknown.escalation, null);
  assert.equal(byId.fri, rows[1], 'unchanged rows keep their identity, so React does not re-render them');
});

test('a newer count that drops below three clears the older rows', () => {
  const cleared = spreadEscalation([
    { ...rows[0], escalation: WEEK },
    { ...rows[1], escalation: null, updated_at: '2026-09-25T06:00:00Z' },
  ]);
  assert.equal(cleared[0].escalation, null);
});

test('the filter finds escalated instructors, and the rest', () => {
  const spread = spreadEscalation(rows);
  const ids = (list) => list.map((row) => row._id);
  assert.deepEqual(ids(filterAttendanceRecords(spread, { escalation: 'escalated' })), ['mon', 'fri']);
  assert.deepEqual(ids(filterAttendanceRecords(spread, { escalation: 'not_escalated' })), ['asha', 'lastweek', 'unknown']);
  assert.equal(filterAttendanceRecords(spread, { escalation: '' }).length, rows.length, 'empty means all');
  assert.deepEqual(ids(filterAttendanceRecords(spread, { escalation: 'escalated', status: 'non_compliant', search: 'ravi' })), ['mon', 'fri']);
  assert.deepEqual(ESCALATION_FILTER_OPTIONS.map((option) => option.value), ['escalated', 'not_escalated']);
});

test('the export says escalated with the dates, not "this week"', () => {
  const [header, first, second] = attendanceCsv([rows[1], rows[2]]).split('\r\n');
  const columns = header.split(',');
  assert.equal(columns.indexOf('Escalation'), columns.indexOf('Status') + 1);
  assert.ok(first.includes('Escalated: non-compliant 3 times in the week of Sep 21 - Sep 27, 2026'));
  assert.ok(!first.includes('this week'));
  assert.match(second, /,Compliant,,/, 'not escalated is an empty cell');
});

test('the table shows the column after Status, and the panel filters on it', () => {
  const table = read('src/components/DailyAttendanceTable.tsx');
  const headers = [...table.matchAll(/<th className="p-4 w-\[\d+px\]">([^<]+)<\/th>/g)].map((match) => match[1]);
  assert.equal(headers[headers.indexOf('Status') + 1], 'Escalation');
  // The checkbox column is the one header without a label.
  for (const match of table.matchAll(/colSpan=\{canBulkDelete \? (\d+) : (\d+)\}/g)) {
    assert.equal(Number(match[2]), headers.length, 'the empty-table rows must span every column');
    assert.equal(Number(match[1]), headers.length + 1);
  }
  assert.match(table, /<EscalationTag escalation=\{record\.escalation\} today=\{today\} \/>/);
  assert.match(table, /escalation: escalationFilter,/);
  assert.match(table, /currentRows = spreadEscalation\(currentRows\);/);
  assert.match(table, /setEscalationFilter\(''\);/, 'Clear all resets it');
  assert.match(table, /\+ \(escalationFilter \? 1 : 0\)/, 'the Filters badge counts it');

  const drawer = read('src/components/AttendanceFilterDrawer.tsx');
  assert.ok(drawer.includes('>Escalation</span>'));
  assert.ok(drawer.includes('ESCALATION_FILTER_OPTIONS.map'));
});
