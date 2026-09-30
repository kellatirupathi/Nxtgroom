import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csvParse.ts';
import {
  firstValue,
  headingField,
  importTemplateCsv,
  inBatches,
  isGoogleSheetLink,
  readImportTable,
  roleLabel,
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
  assert.deepEqual(table.missingColumns, ['Gender', 'Role', 'Institute', 'Employee ID', 'Photo Link']);
});

test('an empty sheet is missing every required column', () => {
  assert.deepEqual(readImportTable([]).missingColumns, ['Name', 'Email', 'Gender', 'Role', 'Institute', 'Employee ID', 'Photo Link']);
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
  assert.deepEqual(flagged, [
    { row: 3, name: 'Asha again', email: 'asha@X.com', errors: ['Same email as row 2'] },
    { row: 4, name: 'Ravi', email: 'ravi@x.com', errors: ['Same Employee ID as row 2'] },
  ]);
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
