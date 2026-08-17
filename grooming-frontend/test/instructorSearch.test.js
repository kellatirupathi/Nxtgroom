import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchIndex, searchInstructors } from '../src/lib/instructorSearch.ts';

const roster = [
  { _id: '1', name: 'A Nivedha', email: 'nivedha@nxtwave.co.in', instructor_role: 'CENTRAL_INSTRUCTOR', institute_name: 'Training Institute', instructor_category: 'TECH' },
  { _id: '2', name: 'Aastha Saurabh', email: 'aastha@nxtwave.co.in', instructor_role: 'INSTRUCTOR', institute_name: 'Training Institute', instructor_category: 'ENGLISH' },
  { _id: '3', name: 'Sumit Kumar', email: 'sumit.kumar@nxtwave.co.in', instructor_role: 'CENTRAL_INSTRUCTOR', institute_name: 'Vivekananda global University', instructor_category: 'TECH' },
  { _id: '4', name: 'Nivedha Rao', email: 'rao@example.com', instructor_role: 'INSTRUCTOR', institute_name: 'Alard University', instructor_category: 'TECH' },
  { _id: '5', name: 'No Contact', instructor_role: 'INSTRUCTOR', institute_name: 'Takshasila University', instructor_category: 'TECH' },
];
const index = buildSearchIndex(roster);
const names = (query) => searchInstructors(index, query).map((item) => item.name);

test('an email address finds its owner', () => {
  assert.deepEqual(names('sumit.kumar@nxtwave.co.in'), ['Sumit Kumar']);
  assert.deepEqual(names('aastha@'), ['Aastha Saurabh']);
});

test('a name prefix outranks the same text appearing later', () => {
  // "Nivedha Rao" starts with the query; "A Nivedha" only contains it.
  assert.deepEqual(names('nivedha'), ['Nivedha Rao', 'A Nivedha']);
});

test('every word must match, so extra words narrow the results', () => {
  assert.deepEqual(names('nivedha'), ['Nivedha Rao', 'A Nivedha']);
  assert.deepEqual(names('nivedha alard'), ['Nivedha Rao'], 'the institute narrows it to one');
  assert.deepEqual(names('nivedha nonsense'), [], 'an unmatched word excludes everything');
});

test('institute, role and category are searchable', () => {
  assert.deepEqual(names('vivekananda'), ['Sumit Kumar']);
  assert.deepEqual(names('english'), ['Aastha Saurabh']);
});

test('search is case and whitespace insensitive', () => {
  assert.deepEqual(names('  SUMIT  '), ['Sumit Kumar']);
  assert.deepEqual(names('SuMiT KuMaR'), ['Sumit Kumar']);
});

test('an instructor without an email is still findable by name', () => {
  // Roughly half the roster has no address, so they must not be unreachable.
  assert.deepEqual(names('no contact'), ['No Contact']);
});

test('an empty query lists the roster instead of nothing', () => {
  assert.equal(searchInstructors(index, '').length, roster.length);
  assert.equal(searchInstructors(index, '   ').length, roster.length);
});

test('results are capped so a huge roster cannot flood the list', () => {
  // 599 options rendered per keystroke is wasted work nobody scrolls through.
  const many = Array.from({ length: 599 }, (_, i) => ({
    _id: String(i), name: `Instructor ${i}`, email: `person${i}@nxtwave.co.in`,
  }));
  const big = buildSearchIndex(many);
  assert.equal(searchInstructors(big, 'instructor', 40).length, 40);
  assert.equal(searchInstructors(big, '', 40).length, 40);
});

test('ties fall back to alphabetical rather than array order', () => {
  const tied = buildSearchIndex([
    { _id: 'b', name: 'Zara Khan', email: 'z@x.com' },
    { _id: 'a', name: 'Aman Khan', email: 'a@x.com' },
  ]);
  assert.deepEqual(
    searchInstructors(tied, 'khan').map((item) => item.name),
    ['Aman Khan', 'Zara Khan'],
  );
});
