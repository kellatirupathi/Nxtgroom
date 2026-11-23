import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instituteCsv, instituteExportFileName } from '../src/lib/instituteExport.ts';

const row = {
  college_id: 'c1',
  name: 'Aurora University',
  mode: 'FACE_ONLY',
  present: 12,
  expected: 40,
  instructors: 40,
  present_percent: 30,
  compliant: 9,
  non_compliant: 3,
  compliance_percent: 75,
  enrolled: 30,
  enrolled_percent: 75,
  low_enrolment: false,
};

test('the institutes export has the table figures and each form link', () => {
  const links = new Map([['c1', { college_id: 'c1', name: 'Aurora University', location: '', token: 't', path: '/form/aurora-university/abcdefghijklmnopqrstuvwx' }]]);
  const [header, line, missing] = instituteCsv([row, { ...row, college_id: 'c2', name: 'GMRIT', compliance_percent: null }], links, 'https://nxtgroom-xi.vercel.app').split('\r\n');
  assert.equal(header, 'Institute,Present,Expected,Present %,Compliance %,Compliant,Non-compliant,Instructors,Faces enrolled,Faces enrolled %,Low enrolment,Form link');
  assert.equal(line, 'Aurora University,12,40,30%,75%,9,3,40,30,75%,No,https://nxtgroom-xi.vercel.app/form/aurora-university/abcdefghijklmnopqrstuvwx');
  assert.equal(missing, 'GMRIT,12,40,30%,,9,3,40,30,75%,No,', 'no compliance figure and no link stay empty');
  assert.equal(instituteExportFileName('2026-11-23', '2026-11-23'), 'institutes-2026-11-23.csv');
  assert.equal(instituteExportFileName('2026-11-01', '2026-11-23'), 'institutes-2026-11-01_to_2026-11-23.csv');
  assert.equal(instituteExportFileName('', ''), 'institutes-all.csv');
});

test('the top right reads: period, Add Institute, Export', () => {
  const page = readFileSync(new URL('../src/components/InstituteAnalytics.tsx', import.meta.url), 'utf8');
  const period = page.indexOf('<DateRangeFilter preset={preset}');
  const add = page.indexOf('aria-label="Add institute"');
  const exported = page.indexOf('aria-label="Export institutes"');
  assert.ok(period > 0 && period < add && add < exported, 'in that order');
});
