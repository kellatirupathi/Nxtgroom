import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRecordsFilters, recordsFiltersForStatus, saveRecordsFilters, STATUS_FILTER_OPTIONS } from '../src/attendanceFilters.ts';

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

function memoryStorage() {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)) };
}

test('a status from the Dashboard opens Daily Records on today with only that status filtered', () => {
  for (const { value } of STATUS_FILTER_OPTIONS) {
    const filters = recordsFiltersForStatus(value, '2026-10-05');
    assert.deepEqual(filters, {
      preset: 'today',
      range: { from: '2026-10-05', to: '2026-10-05' },
      search: '',
      college: '',
      role: '',
      status: value,
      escalation: '',
    });
    const storage = memoryStorage();
    saveRecordsFilters(filters, storage);
    assert.equal(loadRecordsFilters(storage, '2026-10-05').status, value, value);
  }
});

test('the Non-compliant tile and every result row on the Dashboard link to Daily Records with the filter', () => {
  const dashboard = read('components/Dashboard.tsx');
  assert.match(dashboard, /const showInRecords = \(status: DashboardStatusKey\) => \{\s*saveRecordsFilters\(recordsFiltersForStatus\(status\)\);\s*onNavigate\('daily-records'\);\s*\};/);
  assert.ok(dashboard.includes("<TileLink onClick={() => showInRecords('non_compliant')}>View in Daily Records</TileLink>"));
  assert.ok(dashboard.includes('<StatusCard data={data} onSelect={showInRecords} />'));
  assert.match(dashboard, /<button\s+type="button"\s+onClick=\{\(\) => onSelect\(row\.key\)\}/);
  const table = read('components/DailyAttendanceTable.tsx');
  assert.ok(table.includes('useState(() => recordsFiltersFromQuery(window.location.search, today) ?? loadRecordsFilters(undefined, today))'), 'Daily Records starts from the address, then the saved filters');
});
