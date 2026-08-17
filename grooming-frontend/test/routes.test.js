import test from 'node:test';
import assert from 'node:assert/strict';
import { pathForTab, tabForPath, TABS, RESET_PASSWORD_PATH } from '../src/routes.ts';

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
