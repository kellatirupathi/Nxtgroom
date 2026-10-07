import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Daily Records: one table on every screen, and no cards', () => {
  const table = read('src/components/DailyAttendanceTable.tsx');
  assert.match(table, /<div className="flex bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden flex-1 flex-col max-lg:min-h-\[20rem\]">/);
  assert.ok(!table.includes('function RecordCard'), 'the card layout is gone');
  assert.ok(!table.includes('<div className="lg:hidden">'));
  assert.ok(!table.includes('hidden lg:flex'), 'the table is not hidden below lg');
  assert.match(table, /overflow-x-auto flex-1 max-lg:overscroll-x-contain/);
});

test('Daily Records: every column width adds up to the table width, on phones and on desktops', () => {
  const table = read('src/components/DailyAttendanceTable.tsx');
  const columns = table.slice(table.indexOf('const RECORD_COLUMNS = ['), table.indexOf('] as const;'));
  const widths = [...columns.matchAll(/width: 'w-\[(\d+)px\] lg:w-\[(\d+)px\]'/g)].map((match) => [Number(match[1]), Number(match[2])]);
  assert.equal(widths.length, 13);
  const compact = widths.reduce((sum, [small]) => sum + small, 0);
  const wide = widths.reduce((sum, [, large]) => sum + large, 0);
  assert.equal(wide, 2110);
  assert.match(table, /const SELECT_COLUMN_WIDTH = 'w-10 lg:w-12';/);
  assert.match(table, new RegExp(`withSelect: 'w-\\[${compact + 40}px\\] lg:w-\\[${wide + 48}px\\]'`));
  assert.match(table, new RegExp(`withoutSelect: 'w-\\[${compact}px\\] lg:w-\\[${wide}px\\]'`));
});

test('Daily Records: the name stays pinned on phones and tablets, and every cell keeps its content', () => {
  const table = read('src/components/DailyAttendanceTable.tsx');
  assert.match(table, /const PINNED_HEAD = 'max-lg:sticky max-lg:left-0 max-lg:z-20 bg-slate-50/);
  assert.match(table, /const PINNED_CELL = 'max-lg:sticky max-lg:left-0 max-lg:z-\[1\]/);
  assert.match(table, /\$\{index === 0 \? PINNED_HEAD : ''\}/);
  assert.match(table, /\$\{selected \? 'max-lg:bg-indigo-50' : 'max-lg:bg-white'\}/);
  assert.match(table, /\$\{selected \? 'bg-indigo-50\/70 max-lg:bg-indigo-50' : ''\}/);
  assert.match(table, /const CELL = 'px-3 py-2\.5 lg:p-4';/);
  assert.match(table, /const HEAD_CELL = 'px-3 py-3 lg:p-4';/);
  for (const piece of [
    '<StatusBadge status={record.status} />',
    '<EscalationTag escalation={record.escalation} today={today} />',
    'formatAttendanceTime(record.check_in_time)',
    'checkoutDateTimeLabel(record.check_in_time, record.check_out_time, record.checkout_status)',
    'attendanceSessionDateLabel(record.check_in_time, record.check_out_time, record.date)',
    '<AttireTag attire={record.attire_type} />',
    'formatCoordinates(record.location_coordinates)',
    "{record.remarks || '--'}",
    "setPhotoTarget({ record, kind: 'checkin' })",
    "setPhotoTarget({ record, kind: 'checkout' })",
    "'checkin')}",
    "'checkout')}",
  ]) {
    assert.ok(table.includes(piece), `the table is missing ${piece}`);
  }
  assert.match(table, /max-lg:sticky max-lg:left-0 max-lg:w-\[calc\(100vw-2\.25rem\)\]">\{message\}/);
});

test('the phone header keeps search, Filters and Export in that order, as full touch targets', () => {
  const table = read('src/components/DailyAttendanceTable.tsx');
  const search = table.indexOf('aria-label="Search attendance records"');
  const filters = table.indexOf('setFiltersOpen(true)');
  const exportButton = table.indexOf('downloadAttendanceCsv(filteredRecords, range)');
  assert.ok(search > 0 && search < filters && filters < exportButton);
  assert.match(table, /h-11 w-full rounded-lg[^"]*sm:h-9/);
  assert.match(table, /aria-label=\{activeFilterCount \? `Filters, \$\{activeFilterCount\} active` : 'Filters'\}/);
  assert.match(table, /aria-label="Export"/);
});

test('Instructors and Users: cards below md, the table from md', () => {
  for (const file of ['src/components/InstructorManagement.tsx', 'src/components/UserManagement.tsx']) {
    const source = read(file);
    assert.match(source, /<div className="md:hidden">/, `${file} has no phone layout`);
    assert.match(source, /<div className="hidden md:flex bg-white/, `${file} shows its table on a phone`);
    assert.equal((source.match(/<RowActionsMenu/g) || []).length, 2, `${file} lost an actions menu`);
  }
  const instructors = read('src/components/InstructorManagement.tsx');
  assert.equal((instructors.match(/<InstructorGenderCell/g) || []).length, 2, 'gender is editable from a phone too');
});

test('report checkpoints stack on a phone instead of scrolling a four-column table', () => {
  const report = read('src/components/GroomingReport.tsx');
  assert.match(report, /<ul className="divide-y[^"]*md:hidden">/);
  assert.match(report, /<div className="hidden md:block bg-white[^"]*overflow-x-auto/);
  const list = report.slice(report.indexOf('md:hidden">'), report.indexOf('hidden md:block'));
  for (const piece of ['item.name', '<CheckStatus status={item.status} />', 'item.observation', 'item.reasoning']) {
    assert.ok(list.includes(piece), `the stacked checkpoint is missing ${piece}`);
  }
});

test('panels pinned to the screen edges clear the system bars in the app', () => {
  assert.match(read('src/components/AttendanceFilterDrawer.tsx'), /<aside className="[^"]*pt-\[var\(--inset-top\)\] pb-\[var\(--inset-bottom\)\]/);
  assert.match(read('src/components/Toast.tsx'), /pt-\[max\(0\.75rem,var\(--inset-top\)\)\]/);
});

test('Settings sections are swipeable chips on a phone and a left-side menu from md', () => {
  const settings = read('src/components/SettingsPage.tsx');
  assert.match(settings, /rounded-full border px-3\.5 py-2 md:w-full md:rounded-md md:border-0/);
  assert.match(settings, /md:w-52 md:overflow-visible md:border-r/, 'a left-side menu on wider screens');
  assert.ok(settings.includes('aria-orientation="vertical"'));
  assert.match(settings, /scrollIntoView\(\{ behavior: 'smooth', inline: 'center', block: 'nearest' \}\)/);
});
