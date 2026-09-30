import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csvParse.ts';
import {
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
