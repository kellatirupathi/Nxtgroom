import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignLabels,
  instructorById,
  instructorByName,
  looksLikeId,
  mergeWords,
  normalizeIdText,
  readLabels,
} from '../src/lib/groupLabels.ts';
import { bodyCropFromFace, dropBadgeFaces, mergeFaces, planTiles, sortLeftToRight } from '../src/lib/personCrop.ts';

// The institute's instructors, with near-misses to make sure only the right
// one is picked.
const ROSTER = [
  { id: 'a', name: 'Dharani Kumari', employee_id: 'NW2000317' },
  { id: 'b', name: 'Vyshnavi Reddy', employee_id: 'NW2000316' },
  { id: 'c', name: 'Keerthi', employee_id: 'NW2000613' },
  { id: 'd', name: 'Naresh Babu', employee_id: 'NW0007351' },
  { id: 'e', name: 'Yasvanth Kumar', employee_id: 'NW0007357' },
  { id: 'x', name: 'Dharani Priya', employee_id: 'NW2000999' },
  { id: 'y', name: 'Ravi Teja', employee_id: 'NW0007358' },
];

// The words as read from the sample photo (720 x 1280): each label is a name
// over an id, above its person.
const word = (text, left, top, width, height = 0.014, confidence = 85) => ({ text, confidence, box: { left, top, width, height } });
const SAMPLE_WORDS = [
  word('Dharani', 0.035, 0.415, 0.11), word('NW2000317', 0.035, 0.435, 0.13, 0.011),
  word('Vyshnavi', 0.215, 0.405, 0.125), word('NW2000316', 0.215, 0.427, 0.13, 0.011),
  word('Keerthi', 0.41, 0.41, 0.1), word('NW2000613', 0.405, 0.435, 0.13, 0.011),
  word('Naresh', 0.615, 0.403, 0.09), word('NW0007351', 0.615, 0.423, 0.13, 0.011),
  word('Yasvanth', 0.83, 0.395, 0.13), word('NW0007357', 0.83, 0.415, 0.13, 0.011),
];
const ASPECT = 720 / 1280;
const PEOPLE = [0.115, 0.27, 0.445, 0.675, 0.9].map((centerX) => ({ centerX, width: 0.21 }));

test('ids read with look-alike letters are put right, and only ids count as ids', () => {
  assert.equal(normalizeIdText('NW2OOO3I7'), 'NW2000317');
  assert.equal(normalizeIdText('nw0007357'), 'NW0007357');
  assert.ok(looksLikeId('NW2000317'));
  assert.ok(!looksLikeId('Dharani'));
  assert.ok(!looksLikeId('2026'));
});

test('an instructor is found by id (exact, or one character off when unique) or by a unique name', () => {
  assert.equal(instructorById('NW2000317', ROSTER).id, 'a');
  assert.equal(instructorById('NW2O00317', ROSTER).id, 'a');
  assert.equal(instructorById('NW200O613', ROSTER).id, 'c');
  assert.equal(instructorById('NW000735', ROSTER), null, 'a missing digit fits two people: not guessed');
  assert.equal(instructorById('NW9999999', ROSTER), null);
  assert.equal(instructorByName('Vyshnavi', ROSTER).id, 'b');
  assert.equal(instructorByName('Dharani', ROSTER), null, 'two Dharanis: not guessed');
  assert.equal(instructorByName('Keerthi', ROSTER).id, 'c');
});

test('the sample photo: every person gets the name and id printed above them', () => {
  const labels = readLabels(SAMPLE_WORDS, ROSTER, ASPECT);
  assert.deepEqual(labels.map((label) => label.instructor?.employee_id), ['NW2000317', 'NW2000316', 'NW2000613', 'NW0007351', 'NW0007357']);
  const assigned = assignLabels(PEOPLE, labels);
  assert.deepEqual(assigned.map((label) => label?.instructor?.name), ['Dharani Kumari', 'Vyshnavi Reddy', 'Keerthi', 'Naresh Babu', 'Yasvanth Kumar']);
});

test('a misread id is saved by the name printed above it', () => {
  const words = SAMPLE_WORDS.map((item) => (item.text === 'NW2000316' ? { ...item, text: 'Nama' } : item));
  const assigned = assignLabels(PEOPLE, readLabels(words, ROSTER, ASPECT));
  assert.equal(assigned[1]?.instructor?.name, 'Vyshnavi Reddy');
});

test('the same word read twice is kept once, so names are not doubled', () => {
  const twice = [...SAMPLE_WORDS, ...SAMPLE_WORDS.map((item) => ({ ...item, confidence: item.confidence - 20 }))];
  const merged = mergeWords(twice);
  assert.equal(merged.length, SAMPLE_WORDS.length);
  assert.equal(readLabels(merged, ROSTER, ASPECT).length, 5);
});

test('a person the detector missed leaves only their own label unused; no one else shifts', () => {
  const withoutSecond = PEOPLE.filter((_, index) => index !== 1);
  const assigned = assignLabels(withoutSecond, readLabels(SAMPLE_WORDS, ROSTER, ASPECT));
  assert.deepEqual(assigned.map((label) => label?.instructor?.name ?? null), ['Dharani Kumari', 'Keerthi', 'Naresh Babu', 'Yasvanth Kumar']);
});

test('an extra "person" (a poster, someone at the back) is left without a name', () => {
  const extra = [...PEOPLE, { centerX: 0.56, width: 0.08 }].sort((a, b) => a.centerX - b.centerX);
  const assigned = assignLabels(extra, readLabels(SAMPLE_WORDS, ROSTER, ASPECT));
  const names = assigned.map((label) => label?.instructor?.name ?? null);
  assert.deepEqual(names.filter(Boolean), ['Dharani Kumari', 'Vyshnavi Reddy', 'Keerthi', 'Naresh Babu', 'Yasvanth Kumar']);
  assert.equal(names[extra.findIndex((spot) => spot.centerX === 0.56)], null);
});

test('a label not in the instructor list still names its person as printed; a name beside its id on one row works', () => {
  const unknown = readLabels([word('Sanjay', 0.1, 0.4, 0.1), word('NW9999999', 0.1, 0.42, 0.13, 0.011)], ROSTER, ASPECT);
  assert.equal(unknown[0].instructor, null);
  const [given] = assignLabels([{ centerX: 0.16, width: 0.2 }], unknown);
  assert.deepEqual([given?.nameText, given?.idText], ['Sanjay', 'NW9999999']);
  const stray = readLabels([word('Welcome', 0.1, 0.1, 0.2)], ROSTER, ASPECT);
  assert.equal(stray.length, 0, 'a stray word that names no one is not a label');
  const sameRow = readLabels([word('Keerthi', 0.1, 0.4, 0.1), word('NW2000613', 0.215, 0.4, 0.13)], ROSTER, ASPECT);
  assert.equal(sameRow[0].instructor?.id, 'c');
});

test('the person is cut out head to feet from the face, kept inside the photo', () => {
  const crop = bodyCropFromFace({ left: 0.1, top: 0.5, width: 0.05, height: 0.03 });
  assert.ok(crop.top < 0.5 && crop.top > 0.49, 'starts just above the face');
  assert.ok(crop.height > 0.25, 'reaches down to the feet');
  assert.ok(crop.left >= 0 && crop.left + crop.width <= 1);
  const edge = bodyCropFromFace({ left: 0.97, top: 0.9, width: 0.05, height: 0.05 });
  assert.ok(edge.left + edge.width <= 1 && edge.top + edge.height <= 1);
});

test('the photo is also looked at in overlapping tiles, and each face is kept once', () => {
  const tiles = planTiles(720, 1280);
  assert.deepEqual(tiles[0], { x: 0, y: 0, width: 720, height: 1280 });
  assert.deepEqual([...new Set(tiles.slice(1).map((tile) => tile.width))], [360, 240], 'halves and thirds of the shorter side');
  for (const tile of tiles.slice(1)) {
    assert.ok(tile.x + tile.width <= 720 && tile.y + tile.height <= 1280);
  }
  assert.deepEqual(planTiles(200, 200), [{ x: 0, y: 0, width: 200, height: 200 }], 'small photos are looked at whole');
  const faces = mergeFaces([
    { left: 0.1, top: 0.5, width: 0.05, height: 0.03, score: 0.8 },
    { left: 0.102, top: 0.501, width: 0.05, height: 0.03, score: 0.95 },
    { left: 0.4, top: 0.5, width: 0.05, height: 0.03, score: 0.9 },
  ]);
  assert.equal(faces.length, 2);
  assert.equal(faces.find((face) => face.left < 0.2).score, 0.95);
  assert.deepEqual(sortLeftToRight([{ left: 0.5, width: 0.1 }, { left: 0.1, width: 0.1 }]).map((face) => face.left), [0.1, 0.5]);
});

test('the photo on an ID card below a face is not taken for a person', () => {
  const face = { left: 0.1, top: 0.2, width: 0.06, height: 0.034 };
  const badge = { left: 0.115, top: 0.3, width: 0.02, height: 0.011 };
  const neighbour = { left: 0.3, top: 0.2, width: 0.06, height: 0.034 };
  const farAwaySmall = { left: 0.6, top: 0.7, width: 0.02, height: 0.011 };
  assert.deepEqual(dropBadgeFaces([face, badge, neighbour, farAwaySmall]), [face, neighbour, farAwaySmall]);
});
