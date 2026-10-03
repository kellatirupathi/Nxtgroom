import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dayLabel,
  ESCALATION_PERIODS,
  escalationCsv,
  escalationFileName,
  escalationsPath,
  filterEscalationRows,
  groupByPerson,
  MAX_RANGE_DAYS,
  periodRange,
  rangeLabel,
  rangeProblem,
  rowReportPath,
  runsOf,
  shortDayLabel,
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
  run_start: '2026-09-22',
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

test('the dates dropdown offers this week, last week, this month and a custom range', () => {
  assert.deepEqual(ESCALATION_PERIODS.map((option) => option.label), ['This week', 'Last week', 'This month', 'Custom range']);
  // Saturday 3 Oct 2026: weeks run Monday to Sunday, a month is the calendar month.
  assert.deepEqual(periodRange('this_week', '2026-10-03'), { from: '2026-09-28', to: '2026-10-04' });
  assert.deepEqual(periodRange('last_week', '2026-10-03'), { from: '2026-09-21', to: '2026-09-27' });
  assert.deepEqual(periodRange('this_month', '2026-10-03'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(periodRange('this_month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(periodRange('custom', '2026-10-03', { from: '2026-09-01', to: '2026-09-15' }), { from: '2026-09-01', to: '2026-09-15' });
  assert.equal(escalationsPath({ from: '2026-10-01', to: '2026-10-31' }), '/api/v2/dashboard/escalations?from=2026-10-01&to=2026-10-31');
});

test('a custom range needs both dates in order and at most 93 days', () => {
  assert.equal(rangeProblem({ from: '2026-09-01', to: '2026-09-15' }), '');
  assert.equal(rangeProblem({ from: '2026-09-15', to: '2026-09-15' }), '');
  assert.match(rangeProblem({ from: '', to: '2026-09-15' }), /both a start and an end date/);
  assert.match(rangeProblem({ from: '2026-09-16', to: '2026-09-15' }), /on or before the end date/);
  assert.equal(MAX_RANGE_DAYS, 93);
  assert.equal(rangeProblem({ from: '2026-07-01', to: '2026-10-01' }), '');
  assert.match(rangeProblem({ from: '2026-07-01', to: '2026-10-02' }), /at most 93 days/);
});

test('dates read the same in every browser', () => {
  assert.equal(dayLabel('2026-09-24'), '24 Sep 2026');
  assert.equal(shortDayLabel('2026-09-29'), 'Tue 29 Sep');
  assert.equal(rangeLabel('2026-09-21', '2026-09-27'), '21 – 27 Sep 2026');
  assert.equal(rangeLabel('2026-09-28', '2026-10-04'), '28 Sep – 4 Oct 2026');
  assert.equal(rangeLabel('2025-12-29', '2026-01-04'), '29 Dec 2025 – 4 Jan 2026');
  assert.equal(rangeLabel('2026-10-03', '2026-10-03'), '3 Oct 2026');
});

test('one row per person with their days by date, and the details split into runs', () => {
  const rows = [
    row({ attendance_id: 'a2', instructor_id: 'i2', name: 'Asha', college_id: 'c2', institute: 'Aditya University', date: '2026-09-22', weekday: 'Tuesday', run_day: 1 }),
    row({ attendance_id: 'r3', date: '2026-09-24', weekday: 'Thursday', run_day: 3 }),
    row({ attendance_id: 'r1', date: '2026-09-22', weekday: 'Tuesday', run_day: 1 }),
    row({ attendance_id: 'r2', date: '2026-09-23', weekday: 'Wednesday', run_day: 2 }),
    row({ attendance_id: 'r5', date: '2026-09-29', weekday: 'Tuesday', run_day: 1, run_length: 3, run_start: '2026-09-29', institute: 'NIAT Pune', college_id: 'c3' }),
  ];
  const people = groupByPerson(rows);
  assert.deepEqual(people.map((person) => `${person.name}: ${person.days.map((day) => day.attendance_id).join(',')}`), [
    'Asha: a2',
    'Ravi Teja: r1,r2,r3,r5',
  ]);
  assert.equal(people[1].institute, 'NIAT Pune', 'the latest day names the institute');
  assert.deepEqual(runsOf(people[1].days).map((run) => `${run.run_start} x${run.run_length}: ${run.days.length}`), [
    '2026-09-22 x3: 3',
    '2026-09-29 x3: 1',
  ]);
});

test('the filters narrow the days by name or institute, institute and weekday; there is no check-out filter', () => {
  const rows = [
    row(),
    row({ attendance_id: 'a2', name: 'Asha', instructor_id: 'i2', college_id: 'c2', institute: 'Aditya University', weekday: 'Tuesday' }),
    row({ attendance_id: 'a3', date: '2026-09-23', weekday: 'Wednesday', check_out_status: 'non_compliant' }),
  ];
  const ids = (list) => list.map((item) => item.attendance_id);
  assert.deepEqual(ids(filterEscalationRows(rows, { search: 'aditya' })), ['a2']);
  assert.deepEqual(ids(filterEscalationRows(rows, { search: 'ravi' })), ['a1', 'a3']);
  assert.deepEqual(ids(filterEscalationRows(rows, { college: 'c1' })), ['a1', 'a3']);
  assert.deepEqual(ids(filterEscalationRows(rows, { weekday: 'Tuesday' })), ['a2']);
  assert.deepEqual(ids(filterEscalationRows(rows, { checkout: 'none' })), ['a1', 'a2', 'a3'], 'a check-out filter is ignored');
  assert.deepEqual(ids(filterEscalationRows(rows, {})), ['a1', 'a2', 'a3']);
  const page = source('components/EscalationsPage.tsx');
  assert.ok(!page.includes('escalations-checkout'));
  assert.ok(!page.includes('Any check-out'));
});

test('report links for both halves, and none for a check-out that did not happen', () => {
  assert.equal(rowReportPath(row(), 'checkin'), '/reports/tokRavi/day/2026-09-24/check-in');
  assert.equal(rowReportPath(row(), 'checkout'), '/reports/tokRavi/day/2026-09-24/check-out');
  assert.equal(rowReportPath(row({ check_out_time: null }), 'checkout'), null);
  assert.equal(rowReportPath(row({ report_token: null }), 'checkin'), null);
});

test('the export has one line per failed day, the results in words, and absolute report links', () => {
  const csv = escalationCsv([row(), row({ attendance_id: 'a2', check_out_time: null, check_out_status: null })], { from: '2026-09-21', to: '2026-09-27' }, 'https://nxtgroom-xi.vercel.app');
  const [header, first, second] = csv.split('\r\n');
  assert.equal(header, 'Period,Instructor Name,Role,Institute,Date,Day,Escalation,Check-in Time,Check-in Result,Check-out Time,Check-out Result,Check-in Report,Check-out Report');
  assert.match(first, /^21 – 27 Sep 2026,Ravi Teja,INSTRUCTOR,NIAT Hyderabad,24 Sep 2026,Thursday,Day 3 of 3 in a row,/);
  assert.match(first, /,Non-compliant,.*,Compliant,https:\/\/nxtgroom-xi\.vercel\.app\/reports\/tokRavi\/day\/2026-09-24\/check-in,https:\/\/nxtgroom-xi\.vercel\.app\/reports\/tokRavi\/day\/2026-09-24\/check-out$/);
  assert.match(second, /,No check-out,https:\/\/[^,]+\/check-in,$/);
  assert.equal(escalationFileName({ from: '2026-10-01', to: '2026-10-31' }), 'escalations-2026-10-01-to-2026-10-31.csv');
  assert.equal(escalationFileName({ from: '2026-10-03', to: '2026-10-03' }), 'escalations-2026-10-03.csv');
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

test('the table is Instructor, Institute and Dates, one clickable row per person, each date with its photos and reports', () => {
  const page = source('components/EscalationsPage.tsx');
  assert.match(page, /apiFetch<EscalationReport>\(escalationsPath\(\{ from: range\.from, to: range\.to \}\)\)/);
  for (const piece of ['id="escalations-period"', 'id="escalations-from"', 'id="escalations-to"', 'id="escalations-search"', 'id="escalations-institute"', 'id="escalations-day"', 'aria-label="Clear filters"', 'escalationCsv(rows, range, window.location.origin)']) {
    assert.ok(page.includes(piece), piece);
  }
  for (const column of ['Instructor', 'Institute', 'Dates']) {
    assert.match(page, new RegExp(`<th scope="col" className="[^"]*">${column}</th>`), column);
  }
  for (const gone of ['>Date</th>', '>Escalation</th>', '>Check-in</th>', '>Photos</th>', '>Reports</th>', 'id="escalations-week"', 'id="escalations-date"']) {
    assert.ok(!page.includes(gone), gone);
  }
  assert.match(page, /people\.map\(\(person\) => \(\s*<tr\s+key=\{person\.instructor_id\}\s+onClick=\{\(\) => setOpenId\(person\.instructor_id\)\}/);
  assert.match(page, /aria-label=\{`Open escalation details for \$\{person\.name\}`\}/);
  // On a phone the institute moves under the name, so the dates fit.
  assert.ok(page.includes('<span className="block text-xs text-slate-500 md:hidden">{person.institute}</span>'));
  // Each date in the cell carries its check-in and check-out photos and reports.
  assert.match(page, /person\.days\.map\(\(day\) => \([\s\S]*?<DayLinks row=\{day\} onPhoto=\{setPhoto\} \/>/);
  for (const label of ['Check-in photo of', 'Check-out photo of', 'Check-in report of', 'Check-out report of']) {
    assert.ok(page.includes(label), label);
  }
  // Clicking the row opens the person's details: every run and day, both halves, remarks.
  assert.match(page, /role="dialog"[\s\S]*aria-labelledby="escalation-person-title"/);
  assert.match(page, /<Half label="Check-in" time=\{day\.check_in_time\} status=\{day\.check_in_status\} remarks=\{day\.check_in_remarks\} \/>/);
  assert.match(page, /<Half label="Check-out" time=\{day\.check_out_time\} status=\{day\.check_out_status\} remarks=\{day\.check_out_remarks\} \/>/);
});

test('the toolbar has search on the left, then the dates, institute, day and Export on the right', () => {
  const page = source('components/EscalationsPage.tsx');
  const order = ['id="escalations-search"', 'id="escalations-period"', 'id="escalations-institute"', 'id="escalations-day"', 'onClick={exportRows}'];
  const positions = order.map((piece) => page.indexOf(piece));
  assert.ok(positions.every((position) => position > 0), 'every control is on the page');
  assert.deepEqual([...positions].sort((left, right) => left - right), positions, order.join(' then '));
  // The right-hand group is pushed to the right edge.
  const group = page.lastIndexOf('<div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto sm:justify-end">', positions[1]);
  assert.ok(group > positions[0] && group < positions[1]);
});
