import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Phone layouts.
 *
 * On a phone the desktop tables showed two columns and scrolled everything
 * else off to the right. Each list now has a card layout below its breakpoint
 * and keeps the table above it. These read the source, so they cannot judge
 * the pixels; they keep both layouts present, keep them from showing at the
 * same time, and keep the cards carrying what the rows carry.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Daily Records: cards below lg, the table from lg, never both', () => {
  const table = read('src/components/DailyAttendanceTable.tsx');
  assert.match(table, /<div className="lg:hidden">/);
  assert.match(table, /<div className="hidden lg:flex bg-white/);
  assert.match(table, /<ul className="grid gap-3 pb-2 md:grid-cols-2">/, 'two cards across on a tablet');
});

test('a record card carries what a row does', () => {
  const table = read('src/components/DailyAttendanceTable.tsx');
  const card = table.slice(table.indexOf('function RecordCard'), table.indexOf('export default function DailyAttendanceTable'));
  for (const piece of [
    '<StatusBadge status={record.status} />',
    '<EscalationTag escalation={record.escalation} today={today} />',
    'formatAttendanceTime(record.check_in_time)',
    'checkoutDateTimeLabel(record.check_in_time, record.check_out_time, record.checkout_status)',
    'attendanceSessionDateLabel(record.check_in_time, record.check_out_time, record.date)',
    '<AttireTag attire={record.attire_type} />',
    'record.remarks',
    "onPhoto('checkin')",
    "onPhoto('checkout')",
    "publicDayReportPath(record.report_token, reportDay, 'checkin')",
    "publicDayReportPath(record.report_token, reportDay, 'checkout')",
  ]) {
    assert.ok(card.includes(piece), `the card is missing ${piece}`);
  }
  // Opening, selecting and the photo viewer go through the table's own handlers.
  assert.match(table, /onOpen=\{\(\) => openRecord\(record\)\}/);
  assert.match(table, /onToggle=\{\(\) => toggleRecord\(attendanceId\)\}/);
  assert.match(table, /onPhoto=\{\(kind\) => setPhotoTarget\(\{ record, kind \}\)\}/);
  assert.match(table, /selectable=\{canBulkDelete\}/);
  // Buttons inside the card must not also open the record.
  assert.match(card, /onClick=\{stop\}/);
});

test('the phone header keeps search, Filters and Export in that order, as full touch targets', () => {
  const table = read('src/components/DailyAttendanceTable.tsx');
  const search = table.indexOf('aria-label="Search attendance records"');
  const filters = table.indexOf('setFiltersOpen(true)');
  const exportButton = table.indexOf('downloadAttendanceCsv(filteredRecords, range)');
  assert.ok(search > 0 && search < filters && filters < exportButton);
  // 44px high on a phone, the desktop's 36px from sm up.
  assert.match(table, /h-11 w-full rounded-lg[^"]*sm:h-9/);
  assert.match(table, /aria-label=\{activeFilterCount \? `Filters, \$\{activeFilterCount\} active` : 'Filters'\}/);
  assert.match(table, /aria-label="Export"/);
});

test('Instructors and Users: cards below md, the table from md', () => {
  for (const file of ['src/components/InstructorManagement.tsx', 'src/components/UserManagement.tsx']) {
    const source = read(file);
    assert.match(source, /<div className="md:hidden">/, `${file} has no phone layout`);
    assert.match(source, /<div className="hidden md:flex bg-white/, `${file} shows its table on a phone`);
    // The same row actions in both layouts.
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

test('Settings sections are swipeable chips on a phone and underlined tabs from sm', () => {
  const settings = read('src/components/SettingsPage.tsx');
  assert.match(settings, /rounded-full border px-3\.5 py-2 sm:rounded-none sm:border-0 sm:border-b-2/);
  assert.match(settings, /scrollIntoView\(\{ behavior: 'smooth', inline: 'center', block: 'nearest' \}\)/);
});
