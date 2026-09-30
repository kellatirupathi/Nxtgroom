import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csvParse.ts';

const cells = (rows) => rows.map((row) => row.cells);

test('plain rows are split on commas', () => {
  assert.deepEqual(cells(parseCsv('Name,Email\nAsha,asha@x.com\n')), [['Name', 'Email'], ['Asha', 'asha@x.com']]);
});

test('quoted cells keep commas, line breaks and doubled quotes', () => {
  const rows = parseCsv('Name,Note\n"Rao, Asha","said ""hi""\nthen left"\n');
  assert.deepEqual(cells(rows), [['Name', 'Note'], ['Rao, Asha', 'said "hi"\nthen left']]);
});

test('CRLF line ends and the byte-order mark Excel writes are handled', () => {
  assert.deepEqual(cells(parseCsv('﻿Name,Email\r\nAsha,a@x.com\r\n')), [['Name', 'Email'], ['Asha', 'a@x.com']]);
});

test('a last row without a line break is kept', () => {
  assert.deepEqual(cells(parseCsv('A,B\n1,2')), [['A', 'B'], ['1', '2']]);
});

test('empty rows are dropped but rows keep their sheet row numbers', () => {
  const rows = parseCsv('Name\n\nAsha\n,\n"Multi\nline"\nRavi\n');
  assert.deepEqual(rows.map((row) => [row.row, row.cells[0]]), [[1, 'Name'], [3, 'Asha'], [5, 'Multi\nline'], [6, 'Ravi']]);
});

test('semicolon and tab separated files are read too', () => {
  assert.deepEqual(cells(parseCsv('Name;Email\nAsha;a@x.com\n')), [['Name', 'Email'], ['Asha', 'a@x.com']]);
  assert.deepEqual(cells(parseCsv('Name\tEmail\nAsha\ta@x.com\n')), [['Name', 'Email'], ['Asha', 'a@x.com']]);
});

test('a comma inside a quoted heading does not decide the separator', () => {
  assert.deepEqual(cells(parseCsv('"Name, full";Email\nAsha;a@x.com')), [['Name, full', 'Email'], ['Asha', 'a@x.com']]);
});

test('an empty file has no rows', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('\n\n'), []);
});
