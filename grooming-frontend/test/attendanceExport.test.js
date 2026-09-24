import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  filterAttendanceRecords,
  STATUS_FILTER_OPTIONS,
  statusLabel,
} from '../src/attendanceFilters.ts';
import { attendanceCsv, attendanceExportFileName, csvCell } from '../src/attendanceExport.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * Daily Records: the status filter, the export, and the filter panel.
 *
 * The status filter and the export both have to agree with what the table
 * shows. A row showing a Non-compliant badge must be found by "Non-compliant"
 * and exported as "Non-compliant" - including old rows stored as `fail`,
 * which display under the normalised name.
 */

const records = [
  { _id: '1', instructor_name: 'Asha', instructor_role: 'Instructor', college_name: 'Campus A', status: 'compliant', check_in_time: '2026-09-24T03:30:00.000Z', attire_type: 'SAREE', remarks: 'Neat' },
  { _id: '2', instructor_name: 'Ravi', instructor_role: 'Instructor', college_name: 'Campus B', status: 'non_compliant', check_in_time: '2026-09-24T03:45:00.000Z', remarks: 'Shirt untucked' },
  { _id: '3', instructor_name: 'Old Row', instructor_role: 'Trainee', college_name: 'Campus A', status: 'fail' },
  { _id: '4', instructor_name: 'Flagged', instructor_role: 'Trainee', college_name: 'Campus A', status: 'needs_review' },
  { _id: '5', instructor_name: null, college_name: 'Campus B', status: 'unidentified' },
  { _id: '6', instructor_name: 'Waiting', college_name: 'Campus B', status: 'pending' },
];

const ids = (list) => list.map((record) => record._id);

test('status filters on what the badge shows, legacy values included', () => {
  assert.deepEqual(ids(filterAttendanceRecords(records, { status: 'compliant' })), ['1', '4']);
  assert.deepEqual(ids(filterAttendanceRecords(records, { status: 'non_compliant' })), ['2', '3']);
  assert.deepEqual(ids(filterAttendanceRecords(records, { status: 'unidentified' })), ['5']);
  assert.deepEqual(ids(filterAttendanceRecords(records, { status: 'pending' })), ['6']);
  assert.equal(filterAttendanceRecords(records, { status: '' }).length, records.length, 'empty means all');
});

test('status combines with institute, role and search', () => {
  assert.deepEqual(ids(filterAttendanceRecords(records, { status: 'compliant', college: 'Campus A', role: 'Trainee' })), ['4']);
  assert.deepEqual(ids(filterAttendanceRecords(records, { status: 'non_compliant', search: 'untucked' })), ['2']);
});

test('every status the table can show is a filter option', () => {
  const values = STATUS_FILTER_OPTIONS.map((option) => option.value).sort();
  assert.deepEqual(values, ['compliant', 'error', 'non_compliant', 'pending', 'unassessed', 'unidentified']);
  assert.equal(statusLabel('fail'), 'Non-compliant');
  assert.equal(statusLabel('done'), 'Compliant');
  assert.equal(statusLabel(undefined), 'Pending AI');
});

test('the export has the table columns and one line per row', () => {
  const csv = attendanceCsv(records.slice(0, 2));
  const [header, first, second] = csv.split('\r\n');
  assert.equal(header, 'Instructor Name,Role,Institute,Date,Check-In,Check-Out,Coordinates,Status,Attire,Remark');
  assert.match(first, /^Asha,Instructor,Campus A,/);
  assert.match(first, /,Compliant,Saree,Neat$/);
  assert.match(second, /,Non-compliant,,Shirt untucked$/);
  assert.equal(csv.split('\r\n').length, 3);
});

test('a cell that would run as a spreadsheet formula is neutralised', () => {
  // Remarks and names are typed by people; "=HYPERLINK(...)" must stay text.
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('+91 98'), "'+91 98");
});

test('commas, quotes and newlines survive the round trip', () => {
  assert.equal(csvCell('Tucked, neat'), '"Tucked, neat"');
  assert.equal(csvCell('He said "ok"'), '"He said ""ok"""');
  assert.equal(csvCell('line one\nline two'), '"line one\nline two"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('--'), '', 'the table placeholder is not data');
});

test('the file is named after the dates it covers', () => {
  assert.equal(attendanceExportFileName({ from: '2026-09-24', to: '2026-09-24' }), 'daily-attendance-2026-09-24.csv');
  assert.equal(attendanceExportFileName({ from: '2026-09-01', to: '2026-09-24' }), 'daily-attendance-2026-09-01_to_2026-09-24.csv');
  assert.equal(attendanceExportFileName({ from: '', to: '' }), 'daily-attendance-all.csv');
});

test('the header is search, then Filters, then Export - and the filters live in the panel', () => {
  const table = read('src/components/DailyAttendanceTable.tsx');
  const search = table.indexOf('aria-label="Search attendance records"');
  const filters = table.indexOf('setFiltersOpen(true)');
  const exportButton = table.indexOf('downloadAttendanceCsv(filteredRecords, range)');
  assert.ok(search > 0 && search < filters && filters < exportButton, 'order must be search, Filters, Export');
  assert.ok(!table.includes('<DateRangeFilter'), 'the date filter moved into the panel');
  assert.ok(!table.includes('aria-label="Filter by institute"'), 'the institute select moved into the panel');

  const drawer = read('src/components/AttendanceFilterDrawer.tsx');
  for (const text of ['<DateRangeFilter', 'All institutes', 'All roles', 'All statuses']) {
    assert.ok(drawer.includes(text), `the panel is missing ${text}`);
  }
  // A click in the date menu is portalled outside the panel, so the panel must
  // not close on a document-wide outside click.
  assert.ok(!drawer.includes("addEventListener('mousedown'"), 'choosing a date must not close the panel');
});

test('the export respects the filters, and the panel sits under the date menu', () => {
  const table = read('src/components/DailyAttendanceTable.tsx');
  assert.match(table, /status: statusFilter,/);
  const drawer = read('src/components/AttendanceFilterDrawer.tsx');
  const dateMenu = read('src/components/DateRangeFilter.tsx');
  const drawerZ = Number(/fixed inset-0 z-\[(\d+)\]/.exec(drawer)[1]);
  const menuZ = Number(/fixed z-\[(\d+)\]/.exec(dateMenu)[1]);
  assert.ok(menuZ > drawerZ, 'the date menu must open above the panel');
});
