import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  displayDate,
  formPagePath,
  formResponsesCsv,
  formResponsesFileName,
  importRowsFromCsv,
  importTemplateCsv,
  keyFromUrlDate,
  longDate,
  urlDateFromKey,
} from '../src/lib/instituteForm.ts';
import { publicFormFromLocation, settingsSectionFromPath, settingsTabPath } from '../src/routes.ts';

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('the form address writes its date as DD_MM_YYYY', () => {
  assert.equal(urlDateFromKey('2026-11-23'), '23_11_2026');
  assert.equal(keyFromUrlDate('23_11_2026'), '2026-11-23');
  assert.equal(keyFromUrlDate('31_02_2026'), null);
  assert.equal(keyFromUrlDate('2026-11-23'), null);
  assert.equal(formPagePath('aurora-university', 'abcdefghijklmnopqrstuvwx'), '/form/aurora-university/abcdefghijklmnopqrstuvwx');
  assert.equal(formPagePath('aurora-university', 'abcdefghijklmnopqrstuvwx', '2026-11-22'), '/form/aurora-university/abcdefghijklmnopqrstuvwx/22_11_2026');
  assert.equal(displayDate('2026-11-23'), '23-11-2026');
  assert.equal(longDate('2026-11-23'), '23 Nov 2026');
});

test('a public form link opens today, a given day, or flags an impossible date', () => {
  assert.deepEqual(publicFormFromLocation('/form/aurora-university/abcdefghijklmnopqrstuvwx'), {
    slug: 'aurora-university', token: 'abcdefghijklmnopqrstuvwx', date: null,
  });
  assert.deepEqual(publicFormFromLocation('/form/aurora-university/abcdefghijklmnopqrstuvwx/22_11_2026/'), {
    slug: 'aurora-university', token: 'abcdefghijklmnopqrstuvwx', date: '2026-11-22',
  });
  assert.equal(publicFormFromLocation('/form/aurora-university/abcdefghijklmnopqrstuvwx/31_02_2026').date, 'invalid');
  assert.equal(publicFormFromLocation('/form/aurora-university/short'), null);
  assert.equal(publicFormFromLocation('/dashboard'), null);
});

test('Form Responses is a settings section of its own', () => {
  assert.equal(settingsTabPath('responses'), '/settings/responses');
  assert.equal(settingsSectionFromPath('/settings/responses'), 'responses');
});

test('a Google Form sheet is read by its column titles, wherever they are', () => {
  const csv = [
    'Timestamp,Email Address,Date,Photo Submission Status,University Name,Grooming Picture,Submitted By,Reason for Non Submission',
    '23/11/2026 10:04:31,a@b.c,23/11/2026,Yes,Aurora University,"https://drive.google.com/open?id=1, https://drive.google.com/open?id=2",Ravi,',
    '23/11/2026 18:00:00,a@b.c,23/11/2026,No,GMRIT,,Sita,University Holiday',
  ].join('\n');
  const { rows, error } = importRowsFromCsv(csv);
  assert.equal(error, undefined);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    row: 2,
    date: '23/11/2026',
    status: 'Yes',
    university: 'Aurora University',
    picture: 'https://drive.google.com/open?id=1, https://drive.google.com/open?id=2',
    submitted_by: 'Ravi',
    reason: '',
    timestamp: '23/11/2026 10:04:31',
  });
  assert.equal(rows[1].reason, 'University Holiday');
});

test('a sheet without the required columns is refused before anything is sent', () => {
  assert.match(importRowsFromCsv('Date,Status\n23/11/2026,Yes').error, /University Name, Submitted By/);
  assert.match(importRowsFromCsv('Date,Status,University Name,Submitted By').error, /no rows/);
  const template = importRowsFromCsv(importTemplateCsv());
  assert.equal(template.error, undefined, 'the template itself imports');
  assert.equal(template.rows.length, 2);
});

test('export has one row per response with its pictures and type', () => {
  const csv = formResponsesCsv([{
    _id: 'r1',
    college_id: 'c1',
    college_name: 'Aurora University',
    form_date: '2026-11-23',
    status: 'yes',
    submitted_by: 'Ravi',
    reason: null,
    reason_other: '',
    reason_label: '',
    photos: [{ id: 'p1', url: 'https://r2.example/p1', thumb_url: null }],
    photo_links: ['https://drive.google.com/open?id=9'],
    source: 'manual',
    submitted_at: '2026-11-23T04:34:31.000Z',
    updated_at: '2026-11-23T04:34:31.000Z',
    edit_count: 0,
  }]);
  const [header, row] = csv.split('\r\n');
  assert.equal(header, 'Date,University Name,Photo Submission Status,Grooming Picture,Photos,Submitted By,Reason for Non Submission,Type,Submitted At,Last Updated');
  assert.match(row, /^23-11-2026,Aurora University,Yes,"https:\/\/r2\.example\/p1 , https:\/\/drive\.google\.com\/open\?id=9",2,Ravi,,Manual,"23 Nov 2026, 10:04 am",/);
  assert.equal(formResponsesFileName('2026-11-01', '2026-11-23'), 'form-responses-2026-11-01_to_2026-11-23.csv');
  assert.equal(formResponsesFileName('', ''), 'form-responses-all.csv');
});

test('Settings is opened from the profile menu, not the sidebar list', () => {
  const sidebar = source('components/Sidebar.tsx');
  const nav = sidebar.slice(sidebar.indexOf('<nav'), sidebar.indexOf('</nav>'));
  assert.ok(!nav.includes("navigate('settings')"), 'the main list has no Settings entry');
  const menu = sidebar.slice(sidebar.indexOf('role="menu"'));
  assert.match(menu, /isElevatedRole\(role\) && \(/);
  assert.match(menu, /navigate\('settings'\)/);
});

test('the public form is shown before sign-in and admin screens use the compact size', () => {
  const app = source('App.tsx');
  assert.ok(app.indexOf('if (publicForm)') < app.indexOf('if (!session.token)'), 'no sign-in is needed for the form');
  assert.match(app, /root\.classList\.toggle\('compact-ui', shellShown && activeTab !== 'overview'\)/);
  assert.match(source('index.css'), /html\.compact-ui \{\s*font-size: clamp\(13px, calc\(0\.52vw \+ 5px\), 16px\);/);
});

test('removing a photo on the form asks first', () => {
  const page = source('components/PublicFormPage.tsx');
  assert.match(page, /title="Remove this photo\?"/);
  assert.match(page, /onRemove=\{\(\) => setRemoving\(\{ kind: 'kept', id: photo\.id \}\)\}/);
  assert.match(page, /body\.append\('keep', JSON\.stringify\(draft\.kept\.map\(\(photo\) => photo\.id\)\)\)/);
});
