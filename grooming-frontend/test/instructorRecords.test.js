import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checkoutVerdict,
  rangeSummaryLabel,
  RECORDS_PERIODS,
  recordDay,
  recordDayLabel,
  recordReportPath,
  recordsPath,
  recordsRange,
  recordsRangeProblem,
  sortRecordsNewestFirst,
  summarizeRecords,
} from '../src/lib/instructorRecords.ts';

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('records open on the last 10 days, with longer periods and a custom range to choose', () => {
  assert.deepEqual(RECORDS_PERIODS.map((option) => option.label), ['Last 10 days', 'Last 30 days', 'Last 90 days', 'All time', 'Custom range']);
  assert.deepEqual(recordsRange('last_10', '2026-10-05'), { from: '2026-09-26', to: '2026-10-05' });
  assert.deepEqual(recordsRange('last_30', '2026-10-05'), { from: '2026-09-06', to: '2026-10-05' });
  assert.deepEqual(recordsRange('last_90', '2026-10-05'), { from: '2026-07-08', to: '2026-10-05' });
  assert.deepEqual(recordsRange('all', '2026-10-05'), { from: '', to: '' });
  assert.deepEqual(recordsRange('custom', '2026-10-05', { from: '2026-08-01', to: '2026-08-31' }), { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(recordsRangeProblem({ from: '2026-08-01', to: '2026-08-31' }), '');
  assert.match(recordsRangeProblem({ from: '', to: '2026-08-31' }), /both/);
  assert.match(recordsRangeProblem({ from: '2026-09-01', to: '2026-08-31' }), /on or before/);
  assert.equal(recordsPath('i-1', { from: '2026-09-26', to: '2026-10-05' }), '/api/v2/attendance/today?instructor_id=i-1&from=2026-09-26&to=2026-10-05&limit=1000');
  assert.equal(recordsPath('i-1', { from: '', to: '' }), '/api/v2/attendance/today?instructor_id=i-1&from=&to=&limit=1000');
  assert.equal(rangeSummaryLabel({ from: '2026-09-26', to: '2026-10-05' }), '26 Sep 2026 – 5 Oct 2026');
  assert.equal(rangeSummaryLabel({ from: '', to: '' }), 'All time');
});

test('each record reads by its day, newest first, with both results and report links', () => {
  const morning = { _id: 'a', attendance_day: '2026-10-05', check_in_time: '2026-10-05T04:30:00.000Z', check_out_time: '2026-10-05T12:30:00.000Z', status: 'non_compliant', checkout_compliance_status: 'COMPLIANT', report_token: 'tok' };
  const earlier = { _id: 'b', attendance_day: '2026-10-03', check_in_time: '2026-10-03T04:30:00.000Z', check_out_time: null, status: 'compliant', report_token: 'tok' };
  const pending = { _id: 'c', check_in_time: '2026-10-04T05:00:00.000Z', status: 'pending', report_token: null };
  assert.deepEqual(sortRecordsNewestFirst([earlier, morning, pending]).map((record) => record._id), ['a', 'c', 'b']);
  assert.equal(recordDayLabel(recordDay(morning)), 'Mon, 5 Oct 2026');
  assert.equal(recordDay(pending), '2026-10-04');
  assert.equal(checkoutVerdict(morning), 'compliant');
  assert.equal(checkoutVerdict(earlier), null, 'no check-out');
  assert.equal(recordReportPath(morning, 'checkin'), '/reports/tok/day/2026-10-05/check-in');
  assert.equal(recordReportPath(morning, 'checkout'), '/reports/tok/day/2026-10-05/check-out');
  assert.equal(recordReportPath(earlier, 'checkout'), null);
  assert.equal(recordReportPath(pending, 'checkin'), null);
  assert.deepEqual(summarizeRecords([morning, earlier, pending]), { total: 3, compliant: 1, nonCompliant: 1, checkedOut: 1 });
});

test('Records sits in each instructor\'s action menu, above Edit and Delete, and opens its own page', () => {
  const page = read('components/InstructorManagement.tsx');
  assert.equal((page.match(/\{ key: 'records', label: 'Records', icon: 'records', onSelect: \(\) => openRecords\(ins\) \},\s*\{ key: 'edit'/g) || []).length, 2, 'phone and desktop menus');
  assert.ok(page.includes('const openRecords = (ins: Instructor) => openChildPath(recordsPagePath({ id: String(ins._id), name: ins.name }));'));
  assert.ok(!page.includes('InstructorRecordsDialog'), 'no longer a modal');
  const records = read('components/InstructorRecordsPage.tsx');
  assert.ok(records.includes("recordsPeriodFromParam(new URLSearchParams(window.location.search).get('period'))"), 'the period comes from the address');
  assert.ok(records.includes('writeQueryParams(recordsPeriodParams(period, custom));'), 'and is kept in it');
  assert.ok(records.includes("closeChildPath('/instructors')"), 'Back returns to Instructors');
  for (const column of ['Date', 'Check-in', 'Check-out', 'Attire', 'Institute', 'Remarks', 'Photos &amp; reports']) {
    assert.ok(records.includes(`<th scope="col" className="px-3 py-3">${column}</th>`), column);
  }
  const menu = read('components/RowActionsMenu.tsx');
  assert.match(menu, /records: CalendarDays/);
});

test('the instructor form is wider and has an optional User ID, generated when left blank and fixed once set', () => {
  const page = read('components/InstructorManagement.tsx');
  assert.ok(page.includes('w-full max-w-3xl overflow-hidden flex flex-col max-h-[90vh]'));
  assert.ok(!page.includes('w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]'));
  assert.ok(page.includes('User ID (Optional)'));
  assert.ok(page.includes("placeholder={isEditMode ? 'Not set' : 'Generated if left blank'}"));
  assert.ok(page.includes('readOnly={userIdLocked}'));
  assert.ok(page.includes('setUserIdLocked(Boolean(ins.instructor_user_id));'));
  assert.ok(page.includes('instructor_user_id: saved.instructor_user_id || formData.instructor_user_id'));
});
