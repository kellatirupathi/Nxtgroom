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
