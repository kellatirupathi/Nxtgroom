import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csvParse.ts';
import {
  blankRequiredFields,
  fieldsInError,
  firstValue,
  guessCollegeId,
  hasIdentifier,
  guessGender,
  guessRole,
  headingField,
  importTemplateCsv,
  inBatches,
  isGoogleSheetLink,
  readImportTable,
  repeatsOf,
  roleLabel,
  runBatches,
  splitRepeats,
} from '../src/instructorImport.ts';

test('headings are matched in any case and under their usual other names', () => {
  assert.equal(headingField('Name'), 'name');
  assert.equal(headingField('EMAIL ID'), 'email');
  assert.equal(headingField('photo_url'), 'photo_url');
  assert.equal(headingField('Image Link'), 'photo_url');
  assert.equal(headingField('College Name'), 'institute');
  assert.equal(headingField('Emp ID'), 'employee_id');
  assert.equal(headingField('Mobile Number'), 'phone_no');
  assert.equal(headingField('Favourite colour'), null);
});

test('headings ignore case, spacing and punctuation', () => {
  assert.equal(headingField('  NAME * '), 'name');
  assert.equal(headingField('e-mail'), 'email');
  assert.equal(headingField('Employee_ID'), 'employee_id');
  assert.equal(headingField('PHOTO-LINK'), 'photo_url');
});

test('an unfamiliar heading is recognised by the words in it', () => {
  assert.equal(headingField('Official Email Address'), 'email');
  assert.equal(headingField('Employee Code (required)'), 'employee_id');
  assert.equal(headingField('Staff ID'), 'employee_id');
  assert.equal(headingField('Employee Name'), 'name');
  assert.equal(headingField('Institute Email'), 'email');
  assert.equal(headingField('Designation'), 'role');
  assert.equal(headingField('Training Centre'), 'institute');
  assert.equal(headingField('WhatsApp Number'), 'phone_no');
  assert.equal(headingField('Profile Picture URL'), 'photo_url');
  assert.equal(headingField('Remarks'), null);
});

test('a cell with two values keeps the first, per field', () => {
  assert.equal(firstValue('email', 'a@x.com, b@x.com'), 'a@x.com');
  assert.equal(firstValue('phone_no', '+91 98765 43210 / 9123456789'), '+91 98765 43210');
  assert.equal(firstValue('gender', 'F / Female'), 'F');
  assert.equal(firstValue('role', 'Central Team, Mentor'), 'Central Team');
  assert.equal(firstValue('employee_id', 'E1 E2'), 'E1');
  // A comma belongs to a name, and a slash to a link.
  assert.equal(firstValue('name', 'Nair, Anjali'), 'Nair, Anjali');
  assert.equal(firstValue('photo_url', 'https://x.com/a/b.jpg'), 'https://x.com/a/b.jpg');
  assert.equal(firstValue('photo_url', 'https://x.com/a.jpg https://x.com/b.jpg'), 'https://x.com/a.jpg');
  assert.equal(firstValue('email', '  '), '');
});

test('of two columns for one field, the first with a value in that row is used', () => {
  const table = readImportTable(parseCsv(
    'Name,Email,Personal Email,Gender,Role,Institute,Employee ID,Photo\n'
    + 'Asha,asha@work.com,asha@home.com,F,Mentor,Aurora,E1,https://x/a.jpg\n'
    + 'Ravi,,ravi@home.com,M,Mentor,Aurora,E2,https://x/r.jpg\n'
    + 'Meera,"meera@work.com; meera@home.com",,F,Mentor,Aurora,E3,https://x/m.jpg\n',
  ));
  assert.deepEqual(table.ignoredColumns, []);
  assert.deepEqual(table.rows.map((row) => row.email), ['asha@work.com', 'ravi@home.com', 'meera@work.com']);
});

test('columns are read in whatever order the sheet has them', () => {
  const table = readImportTable(parseCsv(
    'Photo Link,Email,Name,Role,Gender,Campus,Emp ID,Notes\n'
    + 'https://x/a.jpg, asha@x.com ,Asha Rao,Mentor,F,Aurora,E-7,likes tea\n',
  ));
  assert.deepEqual(table.missingColumns, []);
  assert.deepEqual(table.ignoredColumns, ['Notes']);
  assert.deepEqual(table.rows, [{
    row: 2,
    photo_url: 'https://x/a.jpg',
    email: 'asha@x.com',
    name: 'Asha Rao',
    role: 'Mentor',
    gender: 'F',
    institute: 'Aurora',
    employee_id: 'E-7',
  }]);
});

test('a sheet without a required column says which ones', () => {
  const table = readImportTable(parseCsv('Name,Email,Phone\nAsha,a@x.com,1\n'));
  assert.deepEqual(table.missingColumns, ['Gender', 'Role', 'Employee ID', 'Photo Link']);
  // Still importable: the email finds anyone already in the roster.
  assert.equal(table.hasIdentifier, true);
});

test('a sheet needs an email or employee ID column to find anyone', () => {
  assert.equal(readImportTable(parseCsv('Emp ID,Phone\nE1,98480\n')).hasIdentifier, true);
  assert.equal(readImportTable(parseCsv('Name,Phone\nAsha,98480\n')).hasIdentifier, false);
  assert.equal(readImportTable([]).hasIdentifier, false);
});

test('an Institute Name column and extra columns, in any order', () => {
  const table = readImportTable(parseCsv(
    'Remarks,Institute Name,Photo Link,Employee ID,Role,Gender,Email,Name,Batch\n'
    + 'ok,Aurora Institute,https://x/a.jpg,E1,Mentor,F,a@x.com,Asha,2024\n',
  ));
  assert.deepEqual(table.missingColumns, []);
  assert.deepEqual(table.ignoredColumns, ['Remarks', 'Batch']);
  assert.equal(table.rows[0].institute, 'Aurora Institute');
  assert.equal(table.rows[0].name, 'Asha');
});

test('a row can be looked up by its email or its employee ID', () => {
  assert.equal(hasIdentifier({ row: 2, employee_id: 'E1' }), true);
  assert.equal(hasIdentifier({ row: 2, email: 'a@x.com' }), true);
  assert.equal(hasIdentifier({ row: 2, name: 'Asha', email: ' ' }), false);
});

test('an empty sheet is missing every required column', () => {
  assert.deepEqual(readImportTable([]).missingColumns, ['Name', 'Email', 'Gender', 'Role', 'Employee ID', 'Photo Link']);
});

test('the first row for an email or employee ID is kept and later ones flagged', () => {
  const { unique, flagged } = splitRepeats([
    { row: 2, name: 'Asha', email: 'Asha@x.com', employee_id: 'E1' },
    { row: 3, name: 'Asha again', email: 'asha@X.com', employee_id: 'E2' },
    { row: 4, name: 'Ravi', email: 'ravi@x.com', employee_id: 'E1' },
    { row: 5, name: 'Meera', email: 'meera@x.com' },
    { row: 6, name: 'No email', email: '' },
    { row: 7, name: 'No email either', email: '' },
  ]);
  assert.deepEqual(unique.map((row) => row.row), [2, 5, 6, 7]);
  assert.deepEqual(flagged.map(({ raw: _raw, ...rest }) => rest), [
    { row: 3, name: 'Asha again', email: 'asha@X.com', errors: ['Same email as row 2'] },
    { row: 4, name: 'Ravi', email: 'ravi@x.com', errors: ['Same Employee ID as row 2'] },
  ]);
  // The sheet's values travel with a flagged row, so it can be corrected.
  assert.equal(flagged[0].raw.employee_id, 'E2');
});

test('rows are sent in batches of the given size', () => {
  assert.deepEqual(inBatches([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]]);
  assert.deepEqual(inBatches([], 3), []);
});

test('only a Google Sheets address counts as a sheet link', () => {
  assert.equal(isGoogleSheetLink('https://docs.google.com/spreadsheets/d/abc/edit#gid=0'), true);
  assert.equal(isGoogleSheetLink('https://docs.google.com/document/d/abc'), false);
  assert.equal(isGoogleSheetLink('https://example.com/spreadsheets/abc'), false);
  assert.equal(isGoogleSheetLink('not a link'), false);
});

test('roles read as words in the preview', () => {
  assert.equal(roleLabel('CENTRAL_INSTRUCTOR'), 'Central Instructor');
  assert.equal(roleLabel('MENTOR'), 'Mentor');
});

test('the template has every heading and an example row the import reads back', () => {
  const table = readImportTable(parseCsv(importTemplateCsv('Aurora Institute')));
  assert.deepEqual(table.missingColumns, []);
  assert.deepEqual(table.ignoredColumns, []);
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].institute, 'Aurora Institute');
  assert.equal(table.rows[0].gender, 'Female');
});

test('a flagged reason marks the fields it is about', () => {
  assert.deepEqual([...fieldsInError([
    'Email "x" is not a valid address',
    'Role "Teacher" must be Instructor, Central Instructor, Central Team, Mentor or Other',
    'Photo link is missing',
  ])].sort(), ['email', 'photo_url', 'role']);
  assert.deepEqual(
    [...fieldsInError(['Email a@x.com belongs to Asha but Employee ID E1 belongs to Ravi; change one of them'])].sort(),
    ['email', 'employee_id'],
  );
  assert.deepEqual([...fieldsInError(['Same Employee ID as row 2'])], ['employee_id']);
  assert.deepEqual([...fieldsInError(['They are checked in today'])], []);
});

test('a corrected row lists the required fields still blank, photo aside', () => {
  assert.deepEqual(blankRequiredFields({ row: 2, name: 'Asha', email: ' ', gender: 'FEMALE' }), ['Email', 'Role', 'Employee ID']);
  assert.deepEqual(blankRequiredFields({
    row: 2, name: 'Asha', email: 'a@x.com', gender: 'F', role: 'MENTOR', institute: 'c1', employee_id: 'E1',
  }), []);
});

test('the correction form is preselected from the sheet however it was written', () => {
  assert.equal(guessGender('f / female'), 'FEMALE');
  assert.equal(guessGender('MAN'), 'MALE');
  assert.equal(guessGender('x'), '');
  assert.equal(guessRole('central team.'), 'CENTRAL_TEAM');
  assert.equal(guessRole('Teacher'), '');
  const colleges = [
    { _id: 'c1', name: 'Hyderabad – Kondapur Campus', location: '' },
    { _id: 'c2', name: 'City College', location: 'A' },
    { _id: 'c3', name: 'City College', location: 'B' },
  ];
  assert.equal(guessCollegeId('hyderabad - kondapur campus', colleges), 'c1');
  assert.equal(guessCollegeId('c3', colleges), 'c3');
  assert.equal(guessCollegeId('City College', colleges), '', 'two share the name, so none is guessed');
  assert.equal(guessCollegeId('Nowhere', colleges), '');
});

test('a corrected row repeating one already in Ready is caught before sending', () => {
  const ready = [{ row: 2, email: 'Asha@x.com', employee_id: 'E1' }, { row: 3, email: 'ravi@x.com', employee_id: 'E2' }];
  assert.deepEqual(repeatsOf({ row: 9, email: 'asha@X.com', employee_id: 'E2' }, ready), ['Same email as row 2', 'Same Employee ID as row 3']);
  assert.deepEqual(repeatsOf({ row: 9, email: 'new@x.com', employee_id: 'E9' }, ready), []);
  assert.deepEqual(repeatsOf({ row: 2, email: 'asha@x.com', employee_id: 'E1' }, ready), [], 'a row never repeats itself');
});

test('headings numbered like form questions are read, as in the Google Form responses sheet', () => {
  const table = readImportTable(parseCsv(
    'Timestamp,1. Full Name,2. Employee ID ,3. Official Email ID  ,4. Gender,5. Role,'
    + '6. Current Passport-Size Photo( Accepted file formats: JPG / PNG),Consent for Biometric Data Collection,Validation Status\n'
    + '9/10/2026 15:23:05,Samrat Singh,NW0004809,samrat.singh@nxtwave.co.in,Male,Instructor,https://drive.google.com/open?id=abc,I consent,Valid\n',
  ));
  assert.deepEqual(table.rows[0], {
    row: 2,
    name: 'Samrat Singh',
    employee_id: 'NW0004809',
    email: 'samrat.singh@nxtwave.co.in',
    gender: 'Male',
    role: 'Instructor',
    photo_url: 'https://drive.google.com/open?id=abc',
  });
  assert.deepEqual(table.ignoredColumns, ['Timestamp', 'Consent for Biometric Data Collection', 'Validation Status']);
  assert.equal(headingField('Q3) Email'), 'email');
  assert.equal(headingField('2) Employee ID'), 'employee_id');
});

test('batches run several at a time and all of them run', async () => {
  let active = 0;
  let peak = 0;
  const done = [];
  await runBatches([[1], [2], [3], [4], [5], [6], [7]], 3, async ([value]) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    done.push(value);
    active -= 1;
  });
  assert.equal(peak, 3);
  assert.deepEqual(done.sort(), [1, 2, 3, 4, 5, 6, 7]);
});

test('no batch starts after a stop or a failure, and the failure is reported', async () => {
  const started = [];
  let stop = false;
  await runBatches([[1], [2], [3], [4]], 1, async ([value]) => {
    started.push(value);
    if (value === 2) stop = true;
  }, () => stop);
  assert.deepEqual(started, [1, 2]);

  const attempted = [];
  await assert.rejects(runBatches([[1], [2], [3]], 1, async ([value]) => {
    attempted.push(value);
    if (value === 1) throw new Error('network down');
  }), /network down/);
  assert.deepEqual(attempted, [1]);
});
