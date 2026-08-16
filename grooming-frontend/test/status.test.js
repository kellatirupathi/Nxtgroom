import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCoordinates,
  hasEvaluation,
  imageQualityLabel,
  needsHumanReview,
  normalizeAttendanceStatus,
} from '../src/status.js';

test('maps current and legacy attendance states', () => {
  assert.equal(normalizeAttendanceStatus('compliant'), 'compliant');
  assert.equal(normalizeAttendanceStatus('done'), 'compliant');
  assert.equal(normalizeAttendanceStatus('non_compliant'), 'non_compliant');
  assert.equal(normalizeAttendanceStatus('fail'), 'non_compliant');
  assert.equal(normalizeAttendanceStatus('error'), 'error');
  assert.equal(normalizeAttendanceStatus('review_required'), 'review_required');
  assert.equal(normalizeAttendanceStatus('needs_review'), 'review_required');
  assert.equal(normalizeAttendanceStatus('processing'), 'pending');
  assert.equal(hasEvaluation('error'), false);
  assert.equal(hasEvaluation('review_required'), true);
});

test('human-review notices follow status and evaluation flags', () => {
  assert.equal(needsHumanReview('review_required', { image_quality: 'ADEQUATE' }), true);
  assert.equal(needsHumanReview('non_compliant', { requires_human_review: true }), true);
  assert.equal(needsHumanReview('compliant', { image_quality: 'RETAKE_RECOMMENDED' }), true);
  assert.equal(needsHumanReview('compliant', { image_quality: 'ADEQUATE' }), false);
  assert.equal(imageQualityLabel('RETAKE_RECOMMENDED'), 'Retake recommended');
  assert.equal(imageQualityLabel('ADEQUATE'), 'Adequate');
  assert.equal(imageQualityLabel(null), 'Not reported');
});

test('formats valid coordinates without a third-party lookup', () => {
  assert.equal(formatCoordinates('17.385044,78.486671'), '17.38504, 78.48667');
  assert.equal(formatCoordinates('not-coordinates'), 'not-coordinates');
});
