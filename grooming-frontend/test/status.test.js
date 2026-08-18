import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCoordinates,
  hasEvaluation,
  imageQualityLabel,
  normalizeAttendanceStatus,
} from '../src/status.ts';

test('maps current and legacy attendance states', () => {
  assert.equal(normalizeAttendanceStatus('compliant'), 'compliant');
  assert.equal(normalizeAttendanceStatus('done'), 'compliant');
  assert.equal(normalizeAttendanceStatus('non_compliant'), 'non_compliant');
  assert.equal(normalizeAttendanceStatus('fail'), 'non_compliant');
  assert.equal(normalizeAttendanceStatus('error'), 'error');
  assert.equal(normalizeAttendanceStatus('processing'), 'pending');
  // Records evaluated before human review was removed still carry these. They
  // were compliant results that had been flagged, so they read as compliant
  // rather than falling through to "pending" and looking unanalysed.
  assert.equal(normalizeAttendanceStatus('review_required'), 'compliant');
  assert.equal(normalizeAttendanceStatus('needs_review'), 'compliant');
  assert.equal(hasEvaluation('error'), false);
  assert.equal(hasEvaluation('review_required'), true, 'a legacy record still has a verdict');
});

test('image quality is reported separately from the verdict', () => {
  // Kept after human review was removed because it says something different:
  // the verdict stands either way, but a poor photo is worth retaking.
  assert.equal(imageQualityLabel('RETAKE_RECOMMENDED'), 'Retake recommended');
  assert.equal(imageQualityLabel('ADEQUATE'), 'Adequate');
  assert.equal(imageQualityLabel(null), 'Not reported');
});

test('formats valid coordinates without a third-party lookup', () => {
  assert.equal(formatCoordinates('17.385044,78.486671'), '17.38504, 78.48667');
  assert.equal(formatCoordinates('not-coordinates'), 'not-coordinates');
});
