import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBoaPayload } from '../src/managementPayloads.ts';

test('BOA edits omit an unchanged blank password', () => {
  const form = { name: 'Asha', email: 'asha@example.com', password: '', college_id: 'college-1' };
  assert.deepEqual(buildBoaPayload(form, { editing: true }), {
    name: 'Asha',
    email: 'asha@example.com',
    college_id: 'college-1',
  });
  assert.equal(form.password, '');
});

test('BOA creates and explicit password changes retain the password', () => {
  assert.equal(buildBoaPayload({ password: 'long-password' }).password, 'long-password');
  assert.equal(buildBoaPayload({ password: 'new-long-password' }, { editing: true }).password, 'new-long-password');
});

test('an instructor without a synced institute falls back to its assigned college', () => {
  // Synced instructors carry institute_name from the warehouse; one added by
  // hand carries only the college it was assigned to. The edit dialog resolved
  // that id and the table did not, so the same instructor showed an institute
  // in one place and a dash in the other.
  const colleges = [
    { _id: 'c70904a0a7e644acbcca40f3704b2c59', name: 'Nxtwave Institute of Advanced Technologies' },
    { _id: 'other', name: 'Training Institute' },
  ];
  const instituteFor = (ins) => ins.institute_name
    || colleges.find((college) => String(college._id) === String(ins.college_id))?.name
    || '';

  assert.equal(
    instituteFor({ college_id: 'c70904a0a7e644acbcca40f3704b2c59' }),
    'Nxtwave Institute of Advanced Technologies'
  );
  // The warehouse value wins, because a sync keeps it current.
  assert.equal(
    instituteFor({ institute_name: 'Takshasila University', college_id: 'other' }),
    'Takshasila University'
  );
  // Neither present still renders as absent rather than crashing.
  assert.equal(instituteFor({}), '');
  assert.equal(instituteFor({ college_id: 'unknown-id' }), '');
});
