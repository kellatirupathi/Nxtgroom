export function normalizeAttendanceStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'done':
    case 'compliant':
      return 'compliant';
    case 'fail':
    case 'non_compliant':
      return 'non_compliant';
    case 'needs_review':
    case 'review_required':
      return 'review_required';
    case 'error':
      return 'error';
    default:
      return 'pending';
  }
}

export function hasEvaluation(status) {
  const normalized = normalizeAttendanceStatus(status);
  return normalized === 'compliant' || normalized === 'non_compliant' || normalized === 'review_required';
}

export function needsHumanReview(status, evaluation = {}) {
  return normalizeAttendanceStatus(status) === 'review_required'
    || evaluation.requires_human_review === true
    || evaluation.image_quality === 'RETAKE_RECOMMENDED';
}

export function imageQualityLabel(imageQuality) {
  if (imageQuality === 'RETAKE_RECOMMENDED') return 'Retake recommended';
  if (imageQuality === 'ADEQUATE') return 'Adequate';
  return 'Not reported';
}

export function formatCoordinates(coordinates) {
  if (!coordinates) return '--';
  const [latitude, longitude] = String(coordinates).split(',').map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return String(coordinates);
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}
