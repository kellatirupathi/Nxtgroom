import test from 'node:test';
import assert from 'node:assert/strict';
import { aiRemarksForHalf, evaluationForHalf } from '../src/reportSelection.ts';

const record = {
  _id: 'attendance-1',
  remarks: 'Check-in summary',
  checkout_remarks: 'Check-out summary',
};

test('a check-in evaluation is never reused by the check-out tab', () => {
  const snapshot = {
    attendanceId: 'attendance-1',
    half: 'checkin',
    evaluation: { ai_summary: 'Detailed check-in evaluation' },
  };

  const checkoutEvaluation = evaluationForHalf(snapshot, 'attendance-1', 'checkout');
  assert.equal(checkoutEvaluation, null);
  assert.equal(aiRemarksForHalf('checkout', record, checkoutEvaluation), 'Check-out summary');
});

test('each report half prefers only its own loaded evaluation summary', () => {
  const checkin = { ai_summary: 'Detailed check-in evaluation' };
  const checkout = { ai_summary: 'Detailed check-out evaluation' };

  assert.equal(aiRemarksForHalf('checkin', record, checkin), 'Detailed check-in evaluation');
  assert.equal(aiRemarksForHalf('checkout', record, checkout), 'Detailed check-out evaluation');
});

test('an evaluation from another attendance record is not displayed', () => {
  const snapshot = {
    attendanceId: 'attendance-previous',
    half: 'checkout',
    evaluation: { ai_summary: 'Previous instructor summary' },
  };

  assert.equal(evaluationForHalf(snapshot, 'attendance-1', 'checkout'), null);
});
