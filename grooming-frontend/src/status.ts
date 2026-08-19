import type { AttendanceStatus, ImageQuality } from './types.ts';

export function normalizeAttendanceStatus(status: unknown): AttendanceStatus {
  switch (String(status || '').toLowerCase()) {
    case 'done':
    case 'compliant':
      return 'compliant';
    case 'fail':
    case 'non_compliant':
      return 'non_compliant';
    case 'unassessed':
      return 'unassessed';
    // Records evaluated before the review flag was removed still carry these.
    // They were compliant results that had been flagged, so that is how they
    // read now. The stored value itself is left untouched.
    case 'needs_review':
    case 'review_required':
      return 'compliant';
    case 'error':
      return 'error';
    default:
      return 'pending';
  }
}

export function hasEvaluation(status: unknown): boolean {
  const normalized = normalizeAttendanceStatus(status);
  return normalized === 'compliant' || normalized === 'non_compliant';
}

/**
 * Whether the detail page is worth opening.
 *
 * Wider than hasEvaluation on purpose. An unassessed record has no checkpoint
 * tables, but it still has the photograph, the times, the location and the
 * reason nothing was assessed — which is exactly what someone clicks the row
 * to find out. Only a check-in still being analysed has nothing to show yet.
 */
export function canOpenRecord(status: unknown): boolean {
  return normalizeAttendanceStatus(status) !== 'pending';
}

export function imageQualityLabel(imageQuality: ImageQuality | string | undefined | null): string {
  if (imageQuality === 'RETAKE_RECOMMENDED') return 'Retake recommended';
  if (imageQuality === 'ADEQUATE') return 'Adequate';
  return 'Not reported';
}

export function formatCoordinates(coordinates: unknown): string {
  if (!coordinates) return '--';
  const [latitude, longitude] = String(coordinates).split(',').map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return String(coordinates);
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}
