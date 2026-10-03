import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dayLabel,
  escalatedInstructorCount,
  escalationCsv,
  escalationFileName,
  filterEscalationRows,
  rowReportPath,
  weekOptions,
  weekRangeLabel,
} from '../src/lib/escalationReport.ts';
import { pathForTab, tabForPath, TABS } from '../src/routes.ts';

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

const row = (overrides = {}) => ({
  attendance_id: 'a1',
  instructor_id: 'i1',
  name: 'Ravi Teja',
  role: 'INSTRUCTOR',
  college_id: 'c1',
  institute: 'NIAT Hyderabad',
  date: '2026-09-24',
  weekday: 'Thursday',
  run_day: 3,
  run_length: 3,
  run_start: '2026-09-21',
  check_in_time: '2026-09-24T03:40:00.000Z',
  check_in_status: 'non_compliant',
  check_in_remarks: 'Shirt not tucked in.',
  check_out_time: '2026-09-24T12:30:00.000Z',
  check_out_status: 'compliant',
  check_out_remarks: null,
  has_checkin_photo: true,
  has_checkout_photo: true,
  report_token: 'tokRavi',
  ...overrides,
});

test('the week menu starts at this week, then last week, and keeps a week chosen by date', () => {
  const options = weekOptions('2026-10-03', 3);
  assert.deepEqual(options.map((option) => option.value), ['2026-09-28', '2026-09-21', '2026-09-14']);
  assert.equal(options[0].label, 'This week · 28 Sep – 4 Oct 2026');
  assert.equal(options[1].label, 'Last week · 21 – 27 Sep 2026');
  assert.equal(options[2].label, '14 – 20 Sep 2026');
  const withOlder = weekOptions('2026-10-03', 3, '2026-06-01');
  assert.equal(withOlder.at(-1).value, '2026-06-01');
  assert.equal(weekRangeLabel('2026-06-01'), '1 – 7 Jun 2026');
  assert.equal(dayLabel('2026-09-24'), '24 Sep 2026');
});

test('the filters narrow by name or institute, institute, day and check-out result', () => {
  const rows = [
    row(),
    row({ attendance_id: 'a2', name: 'Asha', instructor_id: 'i2', college_id: 'c2', institute: 'Aditya University', weekday: 'Tuesday', check_out_status: null, check_out_time: null }),
    row({ attendance_id: 'a3', date: '2026-09-23', weekday: 'Wednesday', check_out_status: 'non_compliant' }),
  ];
  const ids = (list) => list.map((item) => item.attendance_id);
  assert.deepEqual(ids(filterEscalationRows(rows, { search: 'aditya' })), ['a2']);
  assert.deepEqual(ids(filterEscalationRows(rows, { search: 'ravi' })), ['a1', 'a3']);
  assert.deepEqual(ids(filterEscalationRows(rows, { college: 'c1' })), ['a1', 'a3']);
  assert.deepEqual(ids(filterEscalationRows(rows, { weekday: 'Tuesday' })), ['a2']);
  assert.deepEqual(ids(filterEscalationRows(rows, { checkout: 'none' })), ['a2']);
  assert.deepEqual(ids(filterEscalationRows(rows, { checkout: 'non_compliant' })), ['a3']);
  assert.deepEqual(ids(filterEscalationRows(rows, { checkout: 'compliant' })), ['a1']);
  assert.deepEqual(ids(filterEscalationRows(rows, {})), ['a1', 'a2', 'a3']);
  assert.equal(escalatedInstructorCount(rows), 2);
});

test('report links for both halves, and none for a check-out that did not happen', () => {
  assert.equal(rowReportPath(row(), 'checkin'), '/reports/tokRavi/day/2026-09-24/check-in');
  assert.equal(rowReportPath(row(), 'checkout'), '/reports/tokRavi/day/2026-09-24/check-out');
  assert.equal(rowReportPath(row({ check_out_time: null }), 'checkout'), null);
  assert.equal(rowReportPath(row({ report_token: null }), 'checkin'), null);
});

test('the export carries every column, the results in words, and absolute report links', () => {
  const csv = escalationCsv([row(), row({ attendance_id: 'a2', check_out_time: null, check_out_status: null })], '2026-09-21', 'https://nxtgroom-xi.vercel.app');
  const [header, first, second] = csv.split('\r\n');
  assert.equal(header, 'Week,Instructor Name,Role,Institute,Date,Day,Escalation,Check-in Time,Check-in Result,Check-out Time,Check-out Result,Check-in Report,Check-out Report');
  assert.match(first, /^21 – 27 Sep 2026,Ravi Teja,INSTRUCTOR,NIAT Hyderabad,24 Sep 2026,Thursday,Day 3 of 3 in a row,/);
  assert.match(first, /,Non-compliant,.*,Compliant,https:\/\/nxtgroom-xi\.vercel\.app\/reports\/tokRavi\/day\/2026-09-24\/check-in,https:\/\/nxtgroom-xi\.vercel\.app\/reports\/tokRavi\/day\/2026-09-24\/check-out$/);
  assert.match(second, /,No check-out,https:\/\/[^,]+\/check-in,$/);
  assert.equal(escalationFileName('2026-09-21'), 'escalations-week-2026-09-21.csv');
});

test('the page has its own address, for administrators only, and no menu lists it', () => {
  assert.equal(pathForTab(TABS.ESCALATIONS), '/dashboard/escalations');
  assert.equal(tabForPath('/dashboard/escalations'), 'escalations');
  const app = source('App.tsx');
  assert.match(app, /const ADMIN_TABS = new Set\(\[[^\]]*'escalations'[^\]]*\]\)/);
  assert.match(app, /activeTab === 'escalations' && isElevatedRole\(session\.role\)/);
  assert.match(app, /<EscalationsPage onBack=\{\(\) => navigate\('dashboard'\)\} \/>/);
  for (const menu of ['components/Sidebar.tsx', 'components/BottomNav.tsx']) {
    assert.ok(!source(menu).includes('escalations'), `${menu} must not list the page`);
  }
  // Reached from "View all" on the Dashboard's escalation card.
  const dashboard = source('components/Dashboard.tsx');
  assert.match(dashboard, /<TileLink tone="rose" onClick=\{onViewAll\}>View all<\/TileLink>/);
  assert.match(dashboard, /onViewAll=\{\(\) => onNavigate\('escalations'\)\}/);
});

test('the page loads the chosen week and offers search, institute, day and check-out filters, Clear and Export', () => {
  const page = source('components/EscalationsPage.tsx');
  assert.match(page, /\/api\/v2\/dashboard\/escalations\?week=\$\{encodeURIComponent\(week\)\}/);
  for (const piece of ['id="escalations-week"', 'id="escalations-date"', 'id="escalations-search"', 'id="escalations-institute"', 'id="escalations-day"', 'id="escalations-checkout"', 'aria-label="Clear filters"', 'escalationCsv(rows, week, window.location.origin)']) {
    assert.ok(page.includes(piece), piece);
  }
  for (const column of ['Instructor', 'Institute', 'Date', 'Day', 'Escalation', 'Check-in', 'Check-out', 'Photos', 'Reports']) {
    assert.ok(page.includes(`<th scope="col" className="px-3 py-3">${column}</th>`), column);
  }
});
