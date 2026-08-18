import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pathForTab,
  tabForPath,
  TABS,
  RESET_PASSWORD_PATH,
  publicDayReportPath,
  publicReportFromLocation,
} from '../src/routes.ts';

test('every screen has its own address', () => {
  // Before this, every screen rendered at "/", so a refresh always returned
  // to Attendance and no page could be bookmarked or shared.
  const paths = Object.values(TABS).map(pathForTab);
  assert.equal(new Set(paths).size, paths.length, 'no two tabs may share a path');
  assert.equal(pathForTab(TABS.DAILY_RECORDS), '/daily-records');
  assert.equal(pathForTab(TABS.USERS), '/users');
  assert.equal(pathForTab(TABS.SETTINGS), '/settings');
  assert.equal(pathForTab(TABS.INSTRUCTORS), '/instructors');
});

test('paths resolve back to the tab that owns them', () => {
  for (const tab of Object.values(TABS)) {
    assert.equal(tabForPath(pathForTab(tab)), tab, `${tab} must round-trip`);
  }
});

test('the root path opens Attendance', () => {
  assert.equal(tabForPath('/'), TABS.OVERVIEW);
  assert.equal(tabForPath(''), TABS.OVERVIEW);
});

test('a trailing slash resolves to the same screen', () => {
  assert.equal(tabForPath('/users/'), TABS.USERS);
  assert.equal(tabForPath('/settings//'), TABS.SETTINGS);
});

test('an unknown path lands somewhere useful instead of rendering nothing', () => {
  assert.equal(tabForPath('/nope'), TABS.OVERVIEW);
  assert.equal(tabForPath('/users/extra/segments'), TABS.OVERVIEW);
});

test('an unknown tab falls back to the Attendance path', () => {
  assert.equal(pathForTab('not-a-tab'), pathForTab(TABS.OVERVIEW));
});

test('the password link path is not claimed by a tab', () => {
  assert.equal(
    Object.values(TABS).some((tab) => pathForTab(tab) === RESET_PASSWORD_PATH),
    false,
    'reset-password is handled by the shell, before the auth gate',
  );
});

test('the detail path carries the record id', () => {
  // Without the id, a refresh or a shared link had nothing to render and the
  // page fell back to "choose a record".
  assert.equal(
    pathForTab(TABS.INSTRUCTOR_DETAIL, 'abc-123'),
    '/daily-records/record/abc-123',
  );
  assert.equal(
    pathForTab(TABS.INSTRUCTOR_DETAIL),
    '/daily-records/record',
    'no id still yields a usable path',
  );
});

test('a detail path with an id still resolves to the detail tab', () => {
  assert.equal(tabForPath('/daily-records/record/abc-123'), TABS.INSTRUCTOR_DETAIL);
  assert.equal(tabForPath('/daily-records/record'), TABS.INSTRUCTOR_DETAIL);
  // The list itself must not be captured by the detail prefix.
  assert.equal(tabForPath('/daily-records'), TABS.DAILY_RECORDS);
});

test('record ids are encoded so an unusual id cannot break the path', () => {
  assert.equal(
    pathForTab(TABS.INSTRUCTOR_DETAIL, 'a/b c'),
    '/daily-records/record/a%2Fb%20c',
  );
});

test('emailed report links are recognised before the auth gate', () => {
  // These are opened by instructors with no account. Falling through to the
  // tab map sent them to the dashboard instead of their report.
  const path = '/reports/LIJJMEDrikTgiuqmUUv3ueOPZftXOnBs/day/2026-08-17';
  const match = path.match(/^\/reports\/([A-Za-z0-9_-]{8,128})\/(day|week)\/(\d{4}-\d{2}-\d{2})\/?$/);
  assert.ok(match, 'the real emailed link must match');
  assert.equal(match[1], 'LIJJMEDrikTgiuqmUUv3ueOPZftXOnBs');
  assert.equal(match[2], 'day');
  assert.equal(match[3], '2026-08-17');
});

test('malformed report links are not treated as reports', () => {
  const re = /^\/reports\/([A-Za-z0-9_-]{8,128})\/(day|week)\/(\d{4}-\d{2}-\d{2})\/?$/;
  for (const bad of [
    '/reports/short/day/2026-08-17',
    '/reports/LIJJMEDrikTgiuqmUUv3ueOPZftXOnBs/day/17-08-2026',
    '/reports/LIJJMEDrikTgiuqmUUv3ueOPZftXOnBs/month/2026-08-17',
    '/daily-records',
  ]) {
    assert.equal(re.test(bad), false, `${bad} must not match`);
  }
});

/**
 * Every address the application can be opened at, checked in one place.
 * A page that resolves to the wrong screen rewrites the address bar to match,
 * so a mistake here silently changes the URL under the user.
 */
test('every route resolves to the screen that owns it', () => {
  const REPORT_RE = /^\/reports\/([A-Za-z0-9_-]{8,128})\/(day|week)\/(\d{4}-\d{2}-\d{2})\/?$/;
  const resolve = (path) => {
    if (REPORT_RE.test(path)) return 'report';
    if (path === RESET_PASSWORD_PATH) return 'reset';
    return tabForPath(path);
  };

  const expected = [
    ['/', TABS.OVERVIEW],
    ['/attendance', TABS.OVERVIEW],
    ['/daily-records', TABS.DAILY_RECORDS],
    ['/daily-records/record/abc-123', TABS.INSTRUCTOR_DETAIL],
    ['/instructors', TABS.INSTRUCTORS],
    ['/users', TABS.USERS],
    ['/settings', TABS.SETTINGS],
    ['/reset-password', 'reset'],
    ['/reports/LIJJMEDrikTgiuqmUUv3ueOPZftXOnBs/day/2026-08-17', 'report'],
    ['/reports/LIJJMEDrikTgiuqmUUv3ueOPZftXOnBs/week/2026-08-17', 'report'],
    ['/nonsense', TABS.OVERVIEW],
  ];
  for (const [path, want] of expected) {
    assert.equal(resolve(path), want, `${path} must resolve to ${want}`);
  }
});

test('a report link is never mistaken for a tab', () => {
  // tabForPath falling back to Attendance is what rewrote the address bar
  // while the report was on screen.
  assert.equal(tabForPath('/reports/LIJJMEDrikTgiuqmUUv3ueOPZftXOnBs/day/2026-08-17'), TABS.OVERVIEW);
  assert.equal(
    Object.values(TABS).some((tab) => pathForTab(tab).startsWith('/reports')),
    false,
    'no tab may claim a /reports path, so the shell must handle it first',
  );
});

test('a day report link names the half it belongs to', () => {
  assert.equal(
    publicDayReportPath('VQddo8RAwJWYQcfurNOktTEQz0NgOTe9', '2026-08-18', 'checkin'),
    '/reports/VQddo8RAwJWYQcfurNOktTEQz0NgOTe9/day/2026-08-18/check-in'
  );
  assert.equal(
    publicDayReportPath('VQddo8RAwJWYQcfurNOktTEQz0NgOTe9', '2026-08-18', 'checkout'),
    '/reports/VQddo8RAwJWYQcfurNOktTEQz0NgOTe9/day/2026-08-18/check-out'
  );
});

test('both halves are recognised, and an older link still opens', () => {
  const at = (pathname) => {
    globalThis.window = { location: { pathname } };
    return publicReportFromLocation();
  };

  assert.deepEqual(at('/reports/abcdefgh12345678/day/2026-08-18/check-in'), {
    token: 'abcdefgh12345678', kind: 'day', date: '2026-08-18', half: 'checkin',
  });
  assert.deepEqual(at('/reports/abcdefgh12345678/day/2026-08-18/check-out'), {
    token: 'abcdefgh12345678', kind: 'day', date: '2026-08-18', half: 'checkout',
  });
  // Links already sent by email carry no half and are check-ins. They have to
  // keep working, so the bare form is not a 404.
  assert.deepEqual(at('/reports/abcdefgh12345678/day/2026-08-18'), {
    token: 'abcdefgh12345678', kind: 'day', date: '2026-08-18', half: 'checkin',
  });
  // A weekly report covers both halves, so it takes no suffix.
  assert.equal(at('/reports/abcdefgh12345678/week/2026-08-17').half, 'checkin');
  // An unrecognised suffix is not a report link at all.
  assert.equal(at('/reports/abcdefgh12345678/day/2026-08-18/check-sideways'), null);
  delete globalThis.window;
});
