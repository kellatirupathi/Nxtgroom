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
