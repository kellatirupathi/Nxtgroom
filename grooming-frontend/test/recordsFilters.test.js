import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  defaultRecordsFilters,
  loadRecordsFilters,
  RECORDS_FILTERS_KEY,
  saveRecordsFilters,
} from '../src/attendanceFilters.ts';

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

const TODAY = '2026-10-03';

test('the filters a reader set come back when they return to Daily Records', () => {
  const storage = memoryStorage();
  const filters = {
    preset: 'last_week',
    range: { from: '2026-09-27', to: TODAY },
    search: 'ravi',
    college: 'NIAT Hyderabad',
    role: 'INSTRUCTOR',
    status: 'non_compliant',
    escalation: 'escalated',
  };
  saveRecordsFilters(filters, storage);
  assert.ok(storage.values.has(RECORDS_FILTERS_KEY));
  assert.deepEqual(loadRecordsFilters(storage, TODAY), filters);
});

test('a named period is worked out again from today; a custom range keeps its dates', () => {
  const storage = memoryStorage();
  saveRecordsFilters({ ...defaultRecordsFilters('2026-09-20'), preset: 'last_week', range: { from: '2026-09-14', to: '2026-09-20' } }, storage);
  assert.deepEqual(loadRecordsFilters(storage, TODAY).range, { from: '2026-09-27', to: TODAY });

  saveRecordsFilters({ ...defaultRecordsFilters(TODAY), preset: 'custom', range: { from: '2026-09-01', to: '2026-09-15' } }, storage);
  assert.deepEqual(loadRecordsFilters(storage, TODAY).range, { from: '2026-09-01', to: '2026-09-15' });
});

test('nothing saved, or anything unreadable, starts on today with nothing narrowed', () => {
  assert.deepEqual(loadRecordsFilters(memoryStorage(), TODAY), defaultRecordsFilters(TODAY));
  assert.deepEqual(loadRecordsFilters(null, TODAY), defaultRecordsFilters(TODAY));

  const broken = memoryStorage();
  broken.setItem(RECORDS_FILTERS_KEY, 'not json');
  assert.deepEqual(loadRecordsFilters(broken, TODAY), defaultRecordsFilters(TODAY));

  const odd = memoryStorage();
  odd.setItem(RECORDS_FILTERS_KEY, JSON.stringify({
    preset: 'forever',
    status: 'deleted',
    escalation: 'maybe',
    search: 42,
    college: 'x'.repeat(500),
  }));
  const loaded = loadRecordsFilters(odd, TODAY);
  assert.equal(loaded.preset, 'today');
  assert.equal(loaded.status, '');
  assert.equal(loaded.escalation, '');
  assert.equal(loaded.search, '');
  assert.equal(loaded.college.length, 200);

  // A custom period without valid dates is not kept.
  const badCustom = memoryStorage();
  badCustom.setItem(RECORDS_FILTERS_KEY, JSON.stringify({ preset: 'custom', range: { from: 'yesterday', to: TODAY } }));
  assert.deepEqual(loadRecordsFilters(badCustom, TODAY).range, defaultRecordsFilters(TODAY).range);

  const throwing = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.deepEqual(loadRecordsFilters(throwing, TODAY), defaultRecordsFilters(TODAY));
  assert.doesNotThrow(() => saveRecordsFilters(defaultRecordsFilters(TODAY), throwing));
});

test('Daily Records starts from the saved filters, saves every change, and offers Clear beside Filters', () => {
  const table = source('components/DailyAttendanceTable.tsx');
  assert.match(table, /const \[savedFilters\] = useState\(\(\) => loadRecordsFilters\(undefined, today\)\);/);
  for (const piece of [
    'useState<DatePreset>(savedFilters.preset)',
    'useState<DateRange>(savedFilters.range)',
    'useState(savedFilters.role)',
    'useState(savedFilters.college)',
    "useState<AttendanceStatus | ''>(savedFilters.status)",
    'useState<EscalationFilter>(savedFilters.escalation)',
    'useState(savedFilters.search)',
  ]) {
    assert.ok(table.includes(piece), piece);
  }
  assert.match(table, /saveRecordsFilters\(\{[\s\S]*?\}, \[preset, range, search, collegeFilter, roleFilter, statusFilter, escalationFilter\]\);/);

  // Shown only when something is narrowed, right after Filters, and it clears
  // the filters and the search together.
  assert.match(table, /\{\(activeFilterCount > 0 \|\| search\) && \(/);
  assert.match(table, /clearAllFilters\(\);\s*setSearch\(''\);/);
  assert.match(table, /aria-label="Clear filters"/);
  const filters = table.indexOf('setFiltersOpen(true)');
  const clear = table.indexOf('aria-label="Clear filters"');
  const exportButton = table.indexOf('downloadAttendanceCsv(filteredRecords, range)');
  assert.ok(filters < clear && clear < exportButton, 'Filters, then Clear, then Export');
});
