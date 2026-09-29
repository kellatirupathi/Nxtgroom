import type { DashboardInstitute } from './types.ts';

/**
 * Formatting and ordering for the Dashboard, kept free of React so it can be
 * tested directly.
 *
 * Day keys are the server's local calendar dates (YYYY-MM-DD in the app's time
 * zone). They are formatted as UTC calendar dates on purpose: turning one into
 * a local Date would move it to the previous day for any viewer west of UTC.
 */

/** How often the page refreshes itself while it is on screen. */
export const DASHBOARD_REFRESH_MS = 30_000;

function keyToUtcDate(dayKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey || '');
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function formatKey(dayKey: string, options: Intl.DateTimeFormatOptions): string {
  const date = keyToUtcDate(dayKey);
  return date ? new Intl.DateTimeFormat('en-IN', { ...options, timeZone: 'UTC' }).format(date) : dayKey;
}

/** "14 Sept" */
export function shortDayLabel(dayKey: string): string {
  return formatKey(dayKey, { day: 'numeric', month: 'short' });
}

/** "Tue, 14 Sept" */
export function tooltipDayLabel(dayKey: string): string {
  return formatKey(dayKey, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "Tuesday" */
export function weekdayLabel(dayKey: string): string {
  return formatKey(dayKey, { weekday: 'long' });
}

/** "84.5%", or an em dash when there is nothing to divide. */
export function formatPercent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}

/** Whole numbers with Indian digit grouping: "1,184". */
export function formatCount(value: number | null | undefined): string {
  return new Intl.NumberFormat('en-IN').format(Number(value) || 0);
}

/** The time a response was generated, in the app's time zone: "5:20:14 pm". */
export function updatedAtLabel(isoTimestamp: string, timeZone: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}

export interface ComplianceChange {
  /** Percentage points, rounded to one decimal. */
  points: number;
  direction: 'up' | 'down' | 'flat';
}

/** The change in compliance since the same weekday last week, or null. */
export function complianceChange(
  current: number | null | undefined,
  previous: number | null | undefined,
): ComplianceChange | null {
  if (typeof current !== 'number' || typeof previous !== 'number') return null;
  const points = Math.round((current - previous) * 10) / 10;
  return { points, direction: points > 0 ? 'up' : points < 0 ? 'down' : 'flat' };
}

export type InstituteSortKey =
  | 'name'
  | 'mode'
  | 'present_percent'
  | 'compliance_percent'
  | 'non_compliant'
  | 'unidentified'
  | 'enrolled_percent';

export interface InstituteSort {
  key: InstituteSortKey;
  /** 1 ascending, -1 descending. */
  direction: 1 | -1;
}

/**
 * Orders the Institutes table. A missing value (no instructors, or nothing
 * analysed yet) sorts last in either direction, so an empty institute never
 * heads the list as though it were the worst or the best. Ties fall back to
 * the name, so the order is stable between refreshes.
 */
export function sortInstitutes(rows: DashboardInstitute[], sort: InstituteSort): DashboardInstitute[] {
  return [...rows].sort((left, right) => {
    const a = left[sort.key];
    const b = right[sort.key];
    if (typeof a === 'string' && typeof b === 'string') {
      const compared = a.localeCompare(b) * sort.direction;
      return compared || left.name.localeCompare(right.name);
    }
    const aMissing = typeof a !== 'number';
    const bMissing = typeof b !== 'number';
    if (aMissing || bMissing) {
      if (aMissing && bMissing) return left.name.localeCompare(right.name);
      return aMissing ? 1 : -1;
    }
    return ((a as number) - (b as number)) * sort.direction || left.name.localeCompare(right.name);
  });
}
