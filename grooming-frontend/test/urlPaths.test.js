import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dialogPath,
  dialogRouteFromPath,
  pathWithQuery,
  settingsSectionFromPath,
  settingsTabFromPath,
  settingsTabPath,
  tabForPath,
  TABS,
} from '../src/routes.ts';
import {
  matchInstructorsByName,
  recordsPagePath,
  recordsPeriodFromParam,
  recordsPeriodParams,
} from '../src/lib/instructorRecords.ts';
import {
  datePresetFromQuery,
  datePresetToQuery,
  defaultRecordsFilters,
  recordsFiltersFromQuery,
  recordsFiltersToQuery,
} from '../src/attendanceFilters.ts';
import { instituteSortFromQuery, instituteSortToQuery } from '../src/dashboardFormat.ts';
import { escalationPeriodFromParam, escalationQueryParams, weekdayFromParam } from '../src/lib/escalationReport.ts';
import { categoryNameProblem, categoryOptions, categoryPath, inUseCategories } from '../src/lib/instructorCategories.ts';

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('each page, form and settings tab has its own address', () => {
  assert.equal(tabForPath('/instructors/records'), TABS.INSTRUCTOR_RECORDS);
  assert.equal(tabForPath('/instructors/new'), TABS.INSTRUCTORS);
  assert.equal(tabForPath('/instructors/64f0c2/edit'), TABS.INSTRUCTORS);
  assert.equal(tabForPath('/users/new'), TABS.USERS);
  for (const view of ['edit', 'password', 'permissions']) assert.equal(tabForPath(`/users/u1/${view}`), TABS.USERS);
  assert.equal(tabForPath('/institutes/new'), TABS.INSTITUTES);
  for (const section of ['notifications', 'identification', 'institutes', 'sync', 'rp', 'reports', 'config']) {
    assert.equal(tabForPath(`/settings/${section}`), TABS.SETTINGS, section);
  }
  assert.equal(tabForPath('/settings/institutes/new'), TABS.SETTINGS);
  assert.equal(tabForPath('/settings/institutes/c1/edit'), TABS.SETTINGS);
  assert.equal(tabForPath('/instructors/64f0c2/delete'), TABS.OVERVIEW, 'unknown sub-paths are not pages');
  assert.equal(tabForPath('/settings/unknown'), TABS.OVERVIEW);
});

test('settings tabs map to their paths and back', () => {
  for (const tab of ['notifications', 'identification', 'colleges', 'sync', 'rp', 'reports', 'config']) {
    assert.equal(settingsTabFromPath(settingsTabPath(tab)), tab);
  }
  assert.equal(settingsTabPath('colleges'), '/settings/institutes');
  assert.equal(settingsTabFromPath('/settings'), 'notifications');
  assert.equal(settingsTabFromPath('/settings/institutes/c1/edit'), 'colleges');
  assert.equal(settingsSectionFromPath('/settings/nope'), 'notifications');
});

test('add, edit and other forms read and write their path', () => {
  assert.deepEqual(dialogRouteFromPath('/instructors', '/instructors'), { view: 'list' });
  assert.deepEqual(dialogRouteFromPath('/instructors/new/', '/instructors'), { view: 'new' });
  assert.deepEqual(dialogRouteFromPath('/instructors/a%20b/edit', '/instructors'), { view: 'edit', id: 'a b' });
  assert.deepEqual(dialogRouteFromPath('/users/u1/permissions', '/users'), { view: 'permissions', id: 'u1' });
  assert.equal(dialogPath('/instructors', { view: 'edit', id: 'a b' }), '/instructors/a%20b/edit');
  assert.equal(dialogPath('/users', { view: 'new' }), '/users/new');
  assert.equal(dialogPath('/settings/institutes', { view: 'list' }), '/settings/institutes');
  assert.equal(pathWithQuery('/instructors', { q: 'ravi kumar', empty: '' }), '/instructors?q=ravi+kumar');
  assert.equal(pathWithQuery('/instructors', { q: '' }), '/instructors');
});

test('an instructor\'s records page is addressed by name and id, with its dates', () => {
  assert.equal(recordsPagePath({ id: '64f0c2', name: 'Ravi Kumar' }), '/instructors/records?name=Ravi+Kumar&id=64f0c2');
  assert.equal(recordsPeriodFromParam('last_30'), 'last_30');
  assert.equal(recordsPeriodFromParam('forever'), 'last_10');
  assert.equal(recordsPeriodFromParam(null), 'last_10');
  assert.deepEqual(recordsPeriodParams('last_10', { from: '2026-09-01', to: '2026-09-30' }), { period: null, from: null, to: null });
  assert.deepEqual(recordsPeriodParams('custom', { from: '2026-09-01', to: '2026-09-30' }), { period: 'custom', from: '2026-09-01', to: '2026-09-30' });
  const people = [{ _id: '1', name: 'Ravi Kumar' }, { _id: '2', name: 'ravi  kumar ' }, { _id: '3', name: 'Asha' }];
  assert.deepEqual(matchInstructorsByName(people, 'Ravi Kumar').map((row) => row._id), ['1', '2']);
  assert.deepEqual(matchInstructorsByName(people, 'asha').map((row) => row._id), ['3']);
  assert.deepEqual(matchInstructorsByName(people, ''), []);
});

test('Daily Records filters round-trip through the address, and bad values fall back', () => {
  const today = '2026-10-05';
  assert.equal(recordsFiltersFromQuery('', today), null, 'no filters in the address uses the saved ones');
  assert.deepEqual(recordsFiltersToQuery(defaultRecordsFilters(today)), {
    period: null, from: null, to: null, q: null, institute: null, role: null, status: null, escalation: null,
  });
  const filters = {
    preset: 'custom',
    range: { from: '2026-09-01', to: '2026-09-30' },
    search: 'ravi',
    college: 'NIAT Hyderabad',
    role: 'INSTRUCTOR',
    status: 'non_compliant',
    escalation: 'escalated',
  };
  const query = new URLSearchParams(Object.entries(recordsFiltersToQuery(filters)).filter(([, value]) => value)).toString();
  assert.deepEqual(recordsFiltersFromQuery(`?${query}`, today), filters);
  assert.deepEqual(recordsFiltersFromQuery('?status=bogus&period=forever', today), defaultRecordsFilters(today));
  assert.deepEqual(datePresetToQuery('last_week', { from: '2026-09-29', to: today }), { period: 'last_week', from: null, to: null });
  assert.deepEqual(datePresetFromQuery('?period=last_month', today), { preset: 'last_month', range: { from: '2026-09-06', to: today } });
});

test('Institutes sorting and Escalations filters are kept in the address', () => {
  assert.deepEqual(instituteSortFromQuery(''), { key: 'present_percent', direction: 1 });
  assert.deepEqual(instituteSortFromQuery('?sort=non_compliant&order=desc'), { key: 'non_compliant', direction: -1 });
  assert.deepEqual(instituteSortFromQuery('?sort=nope'), { key: 'present_percent', direction: 1 });
  assert.deepEqual(instituteSortToQuery({ key: 'present_percent', direction: 1 }), { sort: null, order: null });
  assert.deepEqual(instituteSortToQuery({ key: 'name', direction: 1 }), { sort: 'name', order: 'asc' });

  assert.equal(escalationPeriodFromParam('last_week'), 'last_week');
  assert.equal(escalationPeriodFromParam('x'), 'this_week');
  assert.equal(weekdayFromParam('Monday'), 'Monday');
  assert.equal(weekdayFromParam('Funday'), '');
  assert.deepEqual(
    escalationQueryParams({ period: 'this_week', custom: { from: '', to: '' }, search: '', college: '', weekday: '' }),
    { period: null, from: null, to: null, q: null, institute: null, day: null },
  );
  assert.deepEqual(
    escalationQueryParams({ period: 'custom', custom: { from: '2026-09-01', to: '2026-09-07' }, search: 'ravi', college: 'c1', weekday: 'Friday' }),
    { period: 'custom', from: '2026-09-01', to: '2026-09-07', q: 'ravi', institute: 'c1', day: 'Friday' },
  );
});

test('pages read their filters from the address and write changes back', () => {
  const management = read('components/InstructorManagement.tsx');
  assert.ok(management.includes("useState(() => readQueryParam('q'))"));
  assert.ok(management.includes('writeQueryParams({ q: search || null });'));
  assert.ok(management.includes("openChildPath(dialogPath(LIST_PATH, { view: 'new' }));"));
  assert.ok(management.includes("openChildPath(dialogPath(LIST_PATH, { view: 'edit', id: String(ins._id) }));"));
  const users = read('components/UserManagement.tsx');
  for (const view of ["{ view: 'new' }", "{ view: 'edit', id: row.id }", "{ view: 'password', id: row.id }", "{ view: 'permissions', id: row.id }"]) {
    assert.ok(users.includes(`openDialog(${view})`), view);
  }
  assert.ok(read('components/CollegeManagement.tsx').includes("const LIST_PATH = '/settings/institutes';"));
  const settings = read('components/SettingsPage.tsx');
  assert.ok(settings.includes('const tab = settingsTabFromPath(pathname);'));
  assert.ok(settings.includes('goToPath(settingsTabPath(next))'));
  assert.ok(read('components/EscalationsPage.tsx').includes('writeQueryParams(escalationQueryParams({ period, custom, search, college, weekday }));'));
  assert.ok(read('components/InstituteAnalytics.tsx').includes('writeQueryParams({ ...datePresetToQuery(preset, range), ...instituteSortToQuery(sort) });'));
  assert.ok(read('components/Dashboard.tsx').includes("writeQueryParams({ trend: days === DEFAULT_TREND_DAYS ? null : String(days) });"));
  assert.ok(read('components/InstructorDetail.tsx').includes("writeQueryParams({ half: tab === 'checkout' ? 'checkout' : null });"));
  assert.ok(read('components/ReportsTab.tsx').includes('writeQueryParams({ month: month === latestMonth ? null : month, campuses: openDay || null });'));
  assert.ok(read('components/InstructorSyncPanel.tsx').includes('writeQueryParams({ q: search || null });'));
  assert.ok(read('components/IdentificationSettingsSection.tsx').includes('writeQueryParams({ q: search || null });'));
  assert.ok(!read('components/DailyReportPage.tsx').includes('writeQueryParams'), 'the emailed daily report address is unchanged');
});

test('the instructor form offers the configured categories, and Config manages them', () => {
  assert.deepEqual(categoryOptions(['APTITUDE', 'TECH'], 'TECH'), ['APTITUDE', 'TECH']);
  assert.deepEqual(categoryOptions(['APTITUDE', 'TECH'], 'Data Science'), ['APTITUDE', 'TECH', 'Data Science'], 'a value not listed is still shown');
  assert.deepEqual(categoryOptions(['TECH'], ''), ['TECH']);
  assert.deepEqual(inUseCategories([{ instructor_category: 'TECH' }, { instructor_category: 'aptitude' }, { instructor_category: '' }, {}]), ['aptitude', 'TECH']);
  const existing = [{ name: 'TECH', count: 2 }, { name: 'MATH', count: 0 }];
  assert.equal(categoryNameProblem('  ', existing), 'Enter a category name.');
  assert.equal(categoryNameProblem('tech', existing), 'That category already exists.');
  assert.equal(categoryNameProblem('Tech', existing, 'TECH'), '', 'renaming may change only the case');
  assert.equal(categoryNameProblem('x'.repeat(61), existing), 'Use at most 60 characters.');
  assert.equal(categoryPath('Soft Skills/Comms'), '/api/v2/settings/config/categories/Soft%20Skills%2FComms');

  const form = read('components/InstructorManagement.tsx');
  assert.ok(form.includes('Category (Optional)'));
  assert.ok(form.includes('<option value="">No category</option>'));
  assert.ok(form.includes('instructor_category: ins.instructor_category || \'\','));
  assert.ok(read('components/ConfigSettingsSection.tsx').includes('<InstructorCategoriesSection />'));
  const section = read('components/InstructorCategoriesSection.tsx');
  assert.ok(section.includes("apiJson<InstructorCategory[]>(CATEGORIES_PATH, { method: 'POST', body: { name } })"));
  assert.ok(section.includes("categoryPath(editing), { method: 'PUT', body: { name } }"));
  assert.ok(section.includes("categoryPath(deleting.name), { method: 'DELETE' }"));
  assert.ok(section.includes('disabled={busy || editing !== null || category.count > 0}'), 'a category in use cannot be deleted');
});
