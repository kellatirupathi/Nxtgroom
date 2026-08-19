import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attireSectionTitle,
  improvementTipsFor,
  isUnassessed,
  REPORT_COLUMNS,
  reportTables,
} from '../src/reportLayout.ts';

const row = (code, status) => ({
  code,
  checkpoint_name: code,
  status,
  observation: 'observed',
  reason: 'because',
});

test('the report keeps its four agreed columns', () => {
  assert.deepEqual([...REPORT_COLUMNS], ['Checkpoint', 'Result', 'Observation', 'Evidence']);
});

test('sections render in a fixed order whatever the evaluation contains', () => {
  // A reader comparing two reports should never have to check whether the
  // sections moved, so the order comes from here and not from the response.
  const tables = reportTables({
    footwear_check: [row('M_FOOTWEAR_TYPE', 'PASS')],
    general_idcard_check: [row('ID_PRESENT', 'PASS')],
  });
  assert.deepEqual(tables.map((table) => table.key), [
    'general_idcard_check',
    'grooming_check',
    'attire_check',
    'accessories_check',
    'footwear_check',
  ]);
  // Sections absent from the response still appear, empty, rather than
  // silently shortening the report.
  assert.deepEqual(tables[1].items, []);
});

test('the attire heading names the garment being assessed', () => {
  assert.equal(attireSectionTitle('SAREE'), '3. Attire Check (Saree)');
  assert.equal(attireSectionTitle('KURTI_WITH_DUPATTA'), '3. Attire Check (Kurti with Dupatta)');
  // Men and unclassified photos get the plain heading: naming a garment there
  // would claim something the evaluation never established.
  assert.equal(attireSectionTitle('FORMAL'), '3. Attire Check');
  assert.equal(attireSectionTitle(undefined), '3. Attire Check');
});

test('the attire heading follows the evaluation, not the section list', () => {
  assert.equal(reportTables({ attire_type: 'SAREE' })[2].title, '3. Attire Check (Saree)');
  assert.equal(reportTables({ attire_type: 'KURTI_WITH_DUPATTA' })[2].title, '3. Attire Check (Kurti with Dupatta)');
});

test('rows keep the order the backend sent them in', () => {
  // The backend rebuilds them from the checkpoint table, so preserving order
  // here is what makes two reports comparable line by line.
  const items = [row('ID_PRESENT', 'PASS'), row('ID_VISIBILITY', 'FAIL'), row('ID_CONDITION', 'N/A')];
  assert.deepEqual(
    reportTables({ general_idcard_check: items })[0].items.map((item) => item.code),
    ['ID_PRESENT', 'ID_VISIBILITY', 'ID_CONDITION']
  );
});

test('every checkpoint is shown, including the ones that passed', () => {
  // Hiding passes would turn an audit into a list of accusations, and leave a
  // reader unable to tell a clean report from a partial one.
  const items = [row('A', 'PASS'), row('B', 'FAIL'), row('C', 'N/A')];
  assert.equal(reportTables({ grooming_check: items })[1].items.length, 3);
});

test('a compliant report offers no improvement tips', () => {
  assert.deepEqual(improvementTipsFor({ improvement_tips: [] }), []);
  assert.deepEqual(improvementTipsFor({}), []);
});

test('tips are shown exactly as the backend derived them', () => {
  // Deriving them again in the browser would let the page and the emails
  // advise different things about the same evaluation.
  const tips = ['Wear a formal collared shirt.', 'Replace jeans with formal trousers.'];
  assert.deepEqual(improvementTipsFor({ improvement_tips: tips }), tips);
});

test('an evaluation with no dress code applied is marked unassessed', () => {
  assert.equal(isUnassessed({ unassessed_reason: 'GENDER_NOT_CONFIGURED' }), true);
  assert.equal(isUnassessed({ unassessed_reason: null }), false);
  assert.equal(isUnassessed({}), false);
});

test('a historical report without checkpoint codes still renders', () => {
  // Evaluations stored before the fixed checkpoints have no code and no
  // attire_type. They must keep working rather than being rewritten.
  const legacy = {
    general_idcard_check: [{ checkpoint_name: 'ID Card Check', status: 'PASS', observation: 'Worn.', reason: 'Visible.' }],
  };
  const tables = reportTables(legacy);
  assert.equal(tables.length, 5);
  assert.equal(tables[0].items[0].checkpoint_name, 'ID Card Check');
  assert.equal(tables[2].title, '3. Attire Check');
  assert.deepEqual(improvementTipsFor(legacy), []);
});

test('a report with nothing to assess renders a reason, not empty tables', () => {
  // Both reasons behave the same way: the sections are empty, and rendering
  // five empty tables would read as checks that ran and found nothing wrong.
  assert.equal(isUnassessed({ unassessed_reason: 'NO_PERSON_VISIBLE' }), true);
  assert.equal(isUnassessed({ unassessed_reason: 'GENDER_NOT_CONFIGURED' }), true);
  assert.equal(isUnassessed({ unassessed_reason: null }), false);
  assert.equal(isUnassessed({}), false);
});

test('the check-out report renders the same five tables as the check-in one', () => {
  // Both halves use one component, so the dialog that follows a check-out is
  // the same audit as the one that follows a check-in — five sections in the
  // same order, whichever half produced it.
  const checkout = {
    attire_type: 'KURTI_WITH_DUPATTA',
    improvement_tips: ['Wear a dupatta with the kurti.'],
    general_idcard_check: [row('ID_PRESENT', 'PASS')],
    grooming_check: [row('W_HAIR_NEATNESS', 'PASS')],
    attire_check: [row('W_DUPATTA', 'FAIL')],
    accessories_check: [row('W_EARRINGS', 'PASS')],
    footwear_check: [row('W_FOOTWEAR_TYPE', 'PASS')],
  };
  const tables = reportTables(checkout);
  assert.equal(tables.length, 5);
  assert.deepEqual(tables.map((table) => table.items.length), [1, 1, 1, 1, 1]);
  // The garment names the attire heading on a check-out exactly as it does on
  // a check-in, so a saree check-out is not headed "Kurti".
  assert.equal(tables[2].title, '3. Attire Check (Kurti with Dupatta)');
  assert.deepEqual(improvementTipsFor(checkout), ['Wear a dupatta with the kurti.']);
  // It is a real report, not the unassessed placeholder.
  assert.equal(isUnassessed(checkout), false);
});
