import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attendancePath,
  filterAttendanceRecords,
  localDateValue,
  uniqueRecordValues,
} from '../src/attendanceFilters.js';

const records = [
  { instructor_name: 'Asha', instructor_role: 'Lead Instructor', college_name: 'Campus B', location_coordinates: '17.1,78.2', remarks: 'Compliant' },
  { instructor_name: 'Ravi', instructor_role: 'Trainee', college_name: 'Campus A', location_coordinates: '18.2,79.3', remarks: 'Review needed' },
];

test('builds a date-keyed attendance endpoint and local date value', () => {
  assert.equal(attendancePath('2026-08-14'), '/api/v2/attendance/today?date=2026-08-14');
  assert.equal(attendancePath(''), '/api/v2/attendance/today');
  assert.equal(localDateValue(new Date(2026, 7, 4)), '2026-08-04');
});

test('filters attendance by role, college, and searchable visible fields', () => {
  assert.deepEqual(filterAttendanceRecords(records, { role: 'Trainee' }), [records[1]]);
  assert.deepEqual(filterAttendanceRecords(records, { college: 'Campus B' }), [records[0]]);
  assert.deepEqual(filterAttendanceRecords(records, { search: '79.3' }), [records[1]]);
  assert.deepEqual(filterAttendanceRecords(records, { search: 'campus a', role: 'Trainee' }), [records[1]]);
});

test('filter options are unique, sorted, and retain a selected historical value', () => {
  assert.deepEqual(uniqueRecordValues(records, 'college_name'), ['Campus A', 'Campus B']);
  assert.deepEqual(uniqueRecordValues([], 'college_name', 'Campus Z'), ['Campus Z']);
});
