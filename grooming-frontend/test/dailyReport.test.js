import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  repeatedSendTime,
  sendTimeLabel,
  sortedSendTimes,
  suggestedSendTime,
  toTwelveHour,
  toTwentyFourHour,
} from '../src/lib/dailyReportTimes.ts';
import { dailyReportFromLocation } from '../src/routes.ts';
import { currentIndiaMonth, monthLabel, shiftMonth } from '../src/lib/reportMonths.ts';
import {
  DAY_STATUS_OPTIONS,
  dayInstitutes,
  dayReportApiPath,
  dayReportBasePath,
  dayReportCsv,
  dayReportFileName,
  filterDayRows,
} from '../src/lib/dayReport.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');

test('send times are edited in 12-hour form and stored in 24-hour form', () => {
  assert.deepEqual(toTwelveHour('13:00'), { hour: 1, minute: 0, period: 'PM' });
  assert.deepEqual(toTwelveHour('00:30'), { hour: 12, minute: 30, period: 'AM' });
  assert.deepEqual(toTwelveHour('12:00'), { hour: 12, minute: 0, period: 'PM' });
  assert.equal(toTwentyFourHour({ hour: 6, minute: 30, period: 'PM' }), '18:30');
  assert.equal(toTwentyFourHour({ hour: 12, minute: 5, period: 'AM' }), '00:05');
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const value = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    assert.equal(toTwentyFourHour(toTwelveHour(value)), value);
  }
  assert.equal(sendTimeLabel('18:30'), '6:30 PM');
  assert.equal(sendTimeLabel('13:00'), '1:00 PM');
});

test('a repeated time is caught, and a new row suggests a time not yet chosen', () => {
  assert.equal(repeatedSendTime(['13:00', '18:30']), null);
  assert.equal(repeatedSendTime(['13:00', '18:30', '13:00']), '1:00 PM');
  assert.equal(suggestedSendTime([]), '13:00');
  assert.equal(suggestedSendTime(['13:00']), '18:30');
  assert.deepEqual(sortedSendTimes(['18:30', '09:00', '13:00']), ['09:00', '13:00', '18:30']);
});

test('the full-day link is recognised, and nothing else is', () => {
  const at = (pathname) => {
    globalThis.window = { location: { pathname } };
    try {
      return dailyReportFromLocation();
    } finally {
      delete globalThis.window;
    }
  };
  assert.deepEqual(at('/daily-report/30-09-2026/Abc123Abc123Abc123_-'), {
    date: '30-09-2026',
    token: 'Abc123Abc123Abc123_-',
  });
  assert.equal(at('/daily-report/30-09-2026/Abc123Abc123Abc123/')?.date, '30-09-2026');
  assert.equal(at('/daily-report/30-09-2026/short'), null);
  assert.equal(at('/daily-report/2026-09-30/Abc123Abc123Abc123'), null);
  assert.deepEqual(at('/daily-report/30-09-2026/niat-hyderabad/Abc123Abc123Abc123'), {
    date: '30-09-2026',
    campus: 'niat-hyderabad',
    token: 'Abc123Abc123Abc123',
  }, 'a campus report carries the campus name');
  assert.equal(at('/daily-report/30-09-2026/NIAT Hyderabad/Abc123Abc123Abc123'), null);
  assert.equal(at('/daily-report/30-09-2026/a/b/Abc123Abc123Abc123'), null);
  assert.equal(at('/daily-records'), null);
});

test('the page opens before the sign-in gate and never rewrites its own address', () => {
  const app = read('src/App.tsx');
  assert.equal((app.match(/if \(publicReport \|\| dailyReport \|\| resetToken\) return/g) || []).length, 3);
  assert.equal((app.match(/publicReport, dailyReport, resetToken\]\);/g) || []).length, 3);
  const page = app.indexOf('if (dailyReport) {');
  assert.ok(page > 0 && page < app.indexOf('if (!session.token)'), 'rendered before the sign-in screen');
  assert.match(app, /<DailyReportPage date=\{dailyReport\.date\} token=\{dailyReport\.token\} campus=\{dailyReport\.campus\} \/>/);
});

test('the full-day page has the asked-for columns, two photo icons and two report icons', () => {
  const page = read('src/components/DailyReportPage.tsx');
  assert.match(page, /apiFetch<DayReportResponse>\(basePath, \{ auth: false \}\)/);
  assert.match(page, /const basePath = dayReportBasePath\(date, token, campus\);/);
  assert.equal(dayReportBasePath('30-09-2026', 'Abc123Abc123Abc123'), '/api/v2/reports/daily/30-09-2026/Abc123Abc123Abc123');
  assert.equal(dayReportBasePath('30-09-2026', 'Abc123Abc123Abc123', 'niat-hyderabad'), '/api/v2/reports/daily/30-09-2026/niat-hyderabad/Abc123Abc123Abc123');
  const headers = [...page.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map((match) => match[1]);
  assert.deepEqual(headers, ['Date', 'Instructor Name', 'Institute', 'Check-in Time', 'Check-out Time', 'Status', 'Feedback', 'Images', 'Reports']);
  assert.ok(page.includes('<td className="p-3"><StatusPill status={row.status} /></td>'));
  assert.ok(page.includes('<dd className="mt-1"><StatusPill status={row.status} /></dd>'));
  for (const gone of ['HalfStatuses', 'checkout_status', '>Check-in</dt>', '>Check-out</dt>']) {
    assert.ok(!page.includes(gone), gone);
  }
  assert.match(page, /const rows = filterDayRows\(report\.rows, \{ search, institute, status \}\);/);
  assert.match(page, /aria-label="Search instructor name"/);
  assert.match(page, /<option value="">All institutes<\/option>/);
  assert.match(page, /<option value="">All statuses<\/option>/);
  assert.match(page, /saveCsvFile\(dayReportFileName\(report\.date_label, report\.institute\), dayReportCsv\(rows\)\)/);
  assert.match(page, /Export CSV/);
  assert.match(page, /title="Check-in photo"[\s\S]*onOpen\(\{ row, kind: 'checkin' \}\)/);
  assert.match(page, /title="Check-out photo"[\s\S]*onOpen\(\{ row, kind: 'checkout' \}\)/);
  assert.match(page, /\/photo\/\$\{encodeURIComponent\(target\.row\.attendance_id\)\}\/\$\{target\.kind\}/);
  assert.match(page, /href=\{row\.checkin_report_url\}[\s\S]*?title="Check-in report"/);
  assert.match(page, /href=\{row\.checkout_report_url\}[\s\S]*?title="Check-out report"/);
  assert.equal((page.match(/target="_blank"\s*rel="noopener noreferrer"/g) || []).length, 2);
  assert.match(page, /Full day, \{report\.window_label\}/);
  assert.match(read('src/lib/dayReport.ts'), /\n  feedback: string;/);
  assert.match(page, /<td className="p-3 text-slate-600">\{row\.feedback\}<\/td>/);
  assert.match(page, /const REFRESH_MS = 60_000;/);
  assert.match(page, /setInterval\(\(\) => \{\n\s*if \(document\.visibilityState === 'visible'\) void load\(\);\n\s*\}, REFRESH_MS\);/);
});

test('the daily report settings live in the Reports tab, with their own recipients', () => {
  const partners = read('src/components/ReportRecipients.tsx');
  assert.ok(!partners.includes('DailyReportSettings'), 'the RP tab is reporting partners only');
  const reportsTab = read('src/components/ReportsTab.tsx');
  assert.match(reportsTab, /<DailyReportSettings \/>\n {4}<\/section>/, 'below the list of days');
  const settings = read('src/components/DailyReportSettings.tsx');
  assert.match(settings, /const PATH = '\/api\/v2\/settings\/daily-report';/);
  assert.match(settings, /const RECIPIENTS_PATH = `\$\{PATH\}\/recipients`;/);
  assert.ok(!settings.includes('rp-recipients'), 'never the reporting partners list');
  assert.match(settings, /<Toggle\s+id="daily_report_enabled"/);
  assert.match(settings, /const HOURS = Array\.from\(\{ length: 12 \}, \(_, index\) => index \+ 1\);/);
  assert.match(settings, /<option value="AM">AM<\/option>\s*<option value="PM">PM<\/option>/);
  assert.match(settings, /Add time/);
  assert.match(settings, /method: 'PUT', body: \{ times: values \}/);
  assert.match(settings, /method: 'PUT', body: \{ enabled \}/);
  assert.match(settings, /disabled=\{loading \|\| savingTimes \|\| !dirty \|\| Boolean\(repeated\)\}/);
  assert.ok(!settings.includes('day-link'));
  assert.match(settings, /Each day's full report, with its link, is in the list above\./);
  assert.match(settings, /not to the reporting partners on the RP tab\./);
});

test('months step in India time, across year ends', () => {
  assert.equal(currentIndiaMonth(new Date('2026-09-30T17:00:00Z')), '2026-09');
  assert.equal(currentIndiaMonth(new Date('2026-09-30T20:00:00Z')), '2026-10', 'already 1 October in India');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(monthLabel('2026-09'), 'September 2026');
});

test('Settings has a Reports tab listing each day with its counts and report link', () => {
  const settingsPage = read('src/components/SettingsPage.tsx');
  assert.match(read('src/routes.ts'), /'rp' \| 'reports'( \| 'config')?;/);
  assert.match(settingsPage, /onClick=\{\(\) => setTab\('reports'\)\}[\s\S]*?Reports\n\s*<\/button>/);
  assert.match(settingsPage, /\{tab === 'reports' && <ReportsTab \/>\}/);

  const tab = read('src/components/ReportsTab.tsx');
  assert.match(tab, /const DAYS_PATH = '\/api\/v2\/settings\/daily-report\/days';/);
  const headers = [...tab.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map((match) => match[1]);
  assert.deepEqual(headers.slice(0, 5), ['Institute', 'Check-ins', 'Check-outs', 'Not checked out', 'Report'], 'each campus of a day');
  assert.deepEqual(headers.slice(5), ['Date', 'Check-ins', 'Check-outs', 'Checked in, not checked out', 'Report'], 'the days');
  assert.match(tab, /href=\{url\}\s*target="_blank"\s*rel="noopener noreferrer"/);
  assert.match(tab, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(tab, /const REFRESH_MS = 60_000;/, 'the counts stay current');
  assert.match(tab, /max=\{latestMonth\}/, 'no future months');
  assert.match(tab, /const path = dayReportApiPath\(url\);/);
  assert.match(tab, /saveCsvFile\(dayReportFileName\(report\.date_label, report\.institute\), dayReportCsv\(report\.rows\)\)/);
  assert.match(tab, /return `\$\{DAYS_PATH\}\/\$\{encodeURIComponent\(date\)\}\/campuses`;/);
  assert.equal((tab.match(/<ReportLink url=\{day\.report_url\}/g) || []).length, 2, 'the overall report stays on every day');
  assert.equal((tab.match(/\{day\.report_url && <CampusToggle /g) || []).length, 2, 'with Campuses beside it');
  assert.ok(tab.includes("const openCampuses = (date: string) => openChildPath(currentPathWith({ campuses: date }));"), 'Campuses opens a popup, kept in the address');
  assert.ok(tab.includes("const closeCampuses = () => closeChildPath(currentPathWith({ campuses: null }));"));
  assert.match(tab, /role="dialog"\s*aria-modal="true"\s*aria-labelledby="campus-reports-title"/);
  assert.match(tab, /\{openDay && \(\s*<CampusReportsModal/);
  assert.ok(!tab.includes('<Fragment'), 'no longer opens under the row');

  const settings = read('src/components/DailyReportSettings.tsx');
  assert.ok(settings.includes("Also send each institute's report"));
  assert.ok(settings.includes("body: { campus_reports: value }"));
  assert.ok(settings.includes('checked={data.campus_reports === true}'), 'off until turned on');
});

const dayRows = [
  { attendance_id: '1', date: '30/09/2026', name: 'Ravi Teja', institute: 'NIAT Hyderabad', status: 'non_compliant', check_in: '09:11 AM', check_out: '06:05 PM', feedback: 'Tuck the shirt in.', has_checkin_photo: true, has_checkout_photo: true, checkin_report_url: 'https://x.test/r/1/check-in', checkout_report_url: 'https://x.test/r/1/check-out' },
  { attendance_id: '2', date: '30/09/2026', name: 'Asha', institute: 'Training Institute', status: 'compliant', check_in: '09:05 AM', check_out: '-', feedback: 'No improvements needed', has_checkin_photo: true, has_checkout_photo: false, checkin_report_url: 'https://x.test/r/2/check-in', checkout_report_url: null },
  { attendance_id: '3', date: '30/09/2026', name: '=Evil', institute: 'NIAT Hyderabad', status: 'pending', check_in: '12:58 PM', check_out: '-', feedback: 'Analysis in progress', has_checkin_photo: false, has_checkout_photo: false, checkin_report_url: null, checkout_report_url: null },
];

test('the day filters by name, institute and check-in status, together', () => {
  const ids = (rows) => rows.map((row) => row.attendance_id);
  assert.deepEqual(ids(filterDayRows(dayRows, { search: 'ravi' })), ['1']);
  assert.deepEqual(ids(filterDayRows(dayRows, { institute: 'NIAT Hyderabad' })), ['1', '3']);
  assert.deepEqual(ids(filterDayRows(dayRows, { status: 'compliant' })), ['2']);
  assert.deepEqual(ids(filterDayRows(dayRows, { institute: 'NIAT Hyderabad', status: 'pending' })), ['3']);
  assert.equal(filterDayRows(dayRows, {}).length, 3);
  assert.deepEqual(dayInstitutes(dayRows), ['NIAT Hyderabad', 'Training Institute']);
  assert.deepEqual(DAY_STATUS_OPTIONS.map((option) => option.label), ['Compliant', 'Non-compliant', 'Analysis in progress', 'Not assessed', 'Analysis failed']);
});

test('the day exports as a CSV with its links, safe to open in Excel', () => {
  const [header, first, second, third] = dayReportCsv(dayRows).split('\r\n');
  assert.equal(header, 'Date,Instructor Name,Institute,Status,Check-in Time,Check-out Time,Feedback,Check-in Report,Check-out Report');
  assert.equal(first, '30/09/2026,Ravi Teja,NIAT Hyderabad,Non-compliant,09:11 AM,06:05 PM,Tuck the shirt in.,https://x.test/r/1/check-in,https://x.test/r/1/check-out');
  assert.equal(second, '30/09/2026,Asha,Training Institute,Compliant,09:05 AM,,No improvements needed,https://x.test/r/2/check-in,', 'no check-out is an empty cell');
  assert.match(third, /^30\/09\/2026,'=Evil,/, 'a name that looks like a formula stays text');
  assert.equal(dayReportFileName('30/09/2026'), 'daily-report-2026-09-30.csv');
});

test('a report link turns into its API path, and nothing else does', () => {
  assert.equal(
    dayReportApiPath('https://nxtgroom-xi.vercel.app/daily-report/30-09-2026/3f6c1a2e-7b4d-4c1e-9a55-000000000030'),
    '/api/v2/reports/daily/30-09-2026/3f6c1a2e-7b4d-4c1e-9a55-000000000030'
  );
  assert.equal(dayReportApiPath('https://nxtgroom-xi.vercel.app/reports/abc/day/2026-09-30/check-in'), null);
  assert.equal(dayReportApiPath('not a url'), null);
});

test('the reporting partner text says they receive every report', () => {
  const partners = read('src/components/ReportRecipients.tsx');
  assert.ok(!partners.includes('copied when an instructor\'s appearance report is non-compliant'));
  assert.ok(partners.includes('Sent for every check-in report, compliant or not.'));
  assert.ok(partners.includes('Sent for every check-out report, compliant or not.'));
});

test('a campus report link turns into its API path, and its export is named after the campus', () => {
  assert.equal(
    dayReportApiPath('https://nxtgroom-xi.vercel.app/daily-report/30-09-2026/niat-hyderabad/3f6c1a2e-7b4d-4c1e-9a55-000000000030'),
    '/api/v2/reports/daily/30-09-2026/niat-hyderabad/3f6c1a2e-7b4d-4c1e-9a55-000000000030'
  );
  assert.equal(dayReportFileName('30/09/2026', 'NIAT Hyderabad'), 'daily-report-niat-hyderabad-2026-09-30.csv');
  assert.equal(dayReportFileName('30/09/2026', null), 'daily-report-2026-09-30.csv');
});

test('a campus page names its institute and drops the institute filter; the overall page keeps it', () => {
  const page = read('src/components/DailyReportPage.tsx');
  assert.ok(page.includes("const campusReport = typeof report.institute === 'string';"));
  assert.match(page, /\{campusReport && \(\s*<p className="mt-1 flex items-center gap-1\.5 text-base font-bold text-indigo-700">/);
  assert.match(page, /\{!campusReport && \(\s*<select aria-label="Institute"/);
  assert.ok(page.includes('const path = `${basePath}/photo/${encodeURIComponent(target.row.attendance_id)}/${target.kind}`;'));
});

test('the instructor report shows the employee ID and email under the name', () => {
  const page = read('src/components/PublicReportPage.tsx');
  assert.ok(page.includes('employee_id?: string | null;'));
  assert.ok(page.includes('<dt className="text-slate-500">Employee ID</dt>'));
  assert.ok(page.includes('<dd className="font-semibold text-slate-700">{instructor.employee_id}</dd>'));
  assert.ok(page.includes('<dd className="min-w-0 break-all font-semibold text-slate-700">{instructor.email}</dd>'));
});
