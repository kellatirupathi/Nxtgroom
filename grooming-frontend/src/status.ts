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

export function mapUrlForCoordinates(coordinates: unknown): string | null {
  if (!coordinates) return null;
  const [latitude, longitude] = String(coordinates).split(',').map((value) => Number(value.trim()));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;
}
