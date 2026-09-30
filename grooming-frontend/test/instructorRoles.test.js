import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTOR_ROLES, instructorRoleOptions } from '../src/instructorRoles.ts';

test('the form offers instructor, central instructor, central team, mentor and other', () => {
  assert.deepEqual([...INSTRUCTOR_ROLES], ['INSTRUCTOR', 'CENTRAL_INSTRUCTOR', 'CENTRAL_TEAM', 'MENTOR', 'OTHER']);
  assert.deepEqual(instructorRoleOptions([]), ['INSTRUCTOR', 'CENTRAL_INSTRUCTOR', 'CENTRAL_TEAM', 'MENTOR', 'OTHER']);
});

test('the standard roles always come first, in the same order', () => {
  const options = instructorRoleOptions(['OTHER', 'CENTRAL_TEAM', 'MENTOR', 'CENTRAL_INSTRUCTOR', 'INSTRUCTOR', 'INSTRUCTOR']);
  assert.deepEqual(options, ['INSTRUCTOR', 'CENTRAL_INSTRUCTOR', 'CENTRAL_TEAM', 'MENTOR', 'OTHER']);
});

test('a role already in the roster is kept, after the standard ones', () => {
  const options = instructorRoleOptions(['Trainee', 'INSTRUCTOR', null, undefined, '  ', 'Lead Instructor']);
  assert.deepEqual(options, ['INSTRUCTOR', 'CENTRAL_INSTRUCTOR', 'CENTRAL_TEAM', 'MENTOR', 'OTHER', 'Lead Instructor', 'Trainee']);
});

test("the instructor being edited keeps an unusual role instead of losing it", () => {
  assert.ok(instructorRoleOptions([], 'Guest Faculty').includes('Guest Faculty'));
  assert.equal(instructorRoleOptions(['MENTOR'], 'MENTOR').filter((role) => role === 'MENTOR').length, 1);
});
