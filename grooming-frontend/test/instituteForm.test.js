import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calendarDays,
  dayBefore,
  peopleCount,
  peopleRows,
  shiftMonth,
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
import { pathForTab, publicFormFromLocation, tabForPath, TABS } from '../src/routes.ts';

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

test('Form Responses is its own admin page, in the sidebar below Users and not in Settings', () => {
  assert.equal(pathForTab(TABS.FORM_RESPONSES), '/form-responses');
  assert.equal(tabForPath('/form-responses'), 'form-responses');
  assert.equal(tabForPath('/settings/responses'), 'form-responses', 'the old address still opens it');
  const app = source('App.tsx');
  assert.match(app, /const ADMIN_TABS = new Set\(\[[^\]]*'form-responses'[^\]]*\]\)/);
  assert.match(app, /activeTab === 'form-responses' && isElevatedRole\(session\.role\)/);
  const sidebar = source('components/Sidebar.tsx');
  const nav = sidebar.slice(sidebar.indexOf('<nav'), sidebar.indexOf('</nav>'));
  assert.ok(nav.indexOf("navigate('form-responses')") > nav.indexOf("navigate('boa-management')"), 'listed after Users');
  assert.ok(!source('components/SettingsPage.tsx').includes('FormResponses'), 'Settings no longer has the section');
  assert.match(source('components/MorePage.tsx'), /navigate\('form-responses'\)/);
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
  assert.equal(header, 'Date,University Name,Photo Submission Status,Appearance Picture,Photos,People Identified,Unknown People,Submitted By,Reason for Non Submission,Type,Submitted At,Last Updated');
  assert.match(row, /^23-11-2026,Aurora University,Yes,"https:\/\/r2\.example\/p1 , https:\/\/drive\.google\.com\/open\?id=9",2,,0,Ravi,,Manual,"23 Nov 2026, 10:04 am",/);
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

test('the calendar shows whole weeks from Monday, with the edges from the next and previous months', () => {
  const november = calendarDays(2026, 11);
  assert.equal(november.length, 42, 'November 2026 starts on a Sunday, so it needs six weeks');
  assert.deepEqual(november[0], { key: '2026-10-26', day: 26, inMonth: false });
  assert.deepEqual(november[6], { key: '2026-11-01', day: 1, inMonth: true });
  assert.deepEqual(november.at(-1), { key: '2026-12-06', day: 6, inMonth: false });
  const february = calendarDays(2027, 2);
  assert.equal(february.length, 28, 'February 2027 starts on a Monday and fits four weeks');
  assert.equal(february[0].key, '2027-02-01');
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
  assert.equal(dayBefore('2026-03-01'), '2026-02-28');
});

test('the form has no logo or password note, its own calendar, and the picture question from the start', () => {
  const page = source('components/PublicFormPage.tsx');
  assert.ok(!page.includes('/logo.png'), 'no logo at the top');
  assert.ok(!page.includes('>FacultyTrack<'), 'no FacultyTrack name at the top');
  assert.ok(!page.includes('Never submit passwords'), 'no password note');
  assert.ok(!page.includes('type="date"'), 'not the browser date box');
  assert.match(page, /<FormDatePicker/);
  assert.match(page, /\{draft\.status !== 'no' && \(\s*<Card id="question-photos"/);
  assert.match(page, /<QuestionTitle required>Appearance Picture<\/QuestionTitle>/);
  assert.ok(!page.includes('Grooming'), 'the form says Appearance, not Grooming');
  const people = page.indexOf('<Card id="question-people">');
  assert.ok(people > page.indexOf('<Card id="question-photos"') && people < page.indexOf('<Card id="question-submitted_by"'), 'People in the Photos sits between the picture and Submitted By');
  assert.match(page, /const EMPTY_DRAFT: Draft = \{ status: 'yes',/, 'Yes is chosen when the form opens');
  const order = ['id="question-university"', 'id="question-photos"', 'id="question-reason"', 'id="question-submitted_by"'].map((piece) => page.indexOf(piece));
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), 'University, Picture or Reason, then Submitted By');
  const picker = source('components/FormDatePicker.tsx');
  assert.match(picker, /const unavailable = day\.key > today \|\| day\.key < min;/);
  assert.ok(!picker.includes('Yesterday') && !picker.includes('>\n              Today'), 'no Today / Yesterday buttons');
});

test('people across the photos: each named person once, A-Z, then the unnamed', () => {
  const person = (id, instructorId, name, employeeId) => ({ id, instructor_id: instructorId, name, employee_id: employeeId, source: instructorId ? 'label' : 'none', box: null, crop_url: `https://x/${id}` });
  const photos = [
    { id: 'a', url: null, thumb_url: null, people: [person('p1', 'i2', 'Sita Devi', 'NW2'), person('p2', null, null, null)] },
    { id: 'b', url: null, thumb_url: null, people: [person('p3', 'i1', 'Ravi Kumar', 'NW1'), person('p4', 'i2', 'Sita Devi', 'NW2')] },
  ];
  const rows = peopleRows(photos);
  assert.deepEqual(rows.map((row) => [row.label, row.employee_id]), [
    ['Ravi Kumar', 'NW1'],
    ['Sita Devi', 'NW2'],
    ['Not named', null],
  ]);
  assert.deepEqual(peopleCount(photos), { identified: 2, unknown: 1 });
  assert.deepEqual(peopleCount([{ id: 'c', url: null, thumb_url: null }]), { identified: 0, unknown: 0 });
});

test('the form summary and the responses page both show the Name | ID | Image table', () => {
  const table = source('components/PeopleTable.tsx');
  const headers = [...table.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map((match) => match[1]);
  assert.deepEqual(headers, ['Name', 'ID', 'Image']);
  assert.match(source('components/PublicFormPage.tsx'), /<PeopleTable photos=\{response\.photos\}/);
  const responses = source('components/FormResponsesSection.tsx');
  assert.match(responses, /\{ key: 'people', label: 'People' \}/);
  assert.match(responses, /<PeopleTable photos=\{peopleOf\.photos\}/);
});

test('people are found in the browser, named from labels, editable, and sent as small cut-outs', () => {
  const page = source('components/PublicFormPage.tsx');
  assert.match(page, /reader\.readGroupPhoto\(\s*photo\.original,/);
  assert.match(page, /body\.append\('people', JSON\.stringify\(plan\)\)/);
  assert.match(page, /crops\.forEach\(\(crop, index\) => body\.append\('crops', crop,/);
  assert.match(page, /<FormPeopleEditor/);
  const editor = source('components/FormPeopleEditor.tsx');
  const headers = [...editor.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map((match) => match[1]);
  assert.deepEqual(headers, ['Image', 'Name', 'ID']);
  assert.match(editor, /onEdit\(photo\.key, person\.key, 'name', event\.target\.value\)/, 'the name is typed in place');
  assert.match(editor, /onEdit\(photo\.key, person\.key, 'id', event\.target\.value\)/, 'the ID is typed in place');
  assert.match(editor, /border-0 border-b border-transparent bg-transparent px-0/, 'only a line under the text');
  assert.ok(!editor.includes('<select'), 'no drop-down list');
  assert.ok(!editor.includes('Add a person'), 'no Add a person button');
  assert.match(editor, /onClick=\{\(\) => setViewing\(\{ photoKey: photo\.key, index \}\)\}/, 'a person picture opens');
  assert.match(editor, /className="flex w-full max-w-sm flex-col overflow-hidden rounded-lg bg-white shadow-xl"/, 'in a small window, not full screen');
  const reader = source('lib/groupPhotoReader.ts');
  assert.match(reader, /'\/models\/mediapipe-face-detection-full\/model\.json'/);
  assert.match(reader, /'\/models\/tesseract-7\.0\.0'/);
  assert.match(reader, /workerBlobURL: false/, 'the worker is a file from this site, as the security policy requires');
  assert.ok(!/rekognition|face-api|SearchFaces/i.test(reader), 'no face recognition');
});

test('removing a photo on the form asks first', () => {
  const page = source('components/PublicFormPage.tsx');
  assert.match(page, /title="Remove this photo\?"/);
  assert.match(page, /onRemove=\{\(\) => setRemoving\(\{ kind: 'kept', id: photo\.id \}\)\}/);
  assert.match(page, /body\.append\('keep', JSON\.stringify\(draft\.kept\.map\(\(photo\) => photo\.id\)\)\)/);
});
