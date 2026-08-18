import type { AttendanceRecord } from './types.ts';

export function localDateValue(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function attendancePath(date?: string | null): string {
  if (!date) return '/api/v2/attendance/today';
  return `/api/v2/attendance/today?${new URLSearchParams({ date }).toString()}`;
}

export type DatePreset = 'today' | 'last_week' | 'last_month' | 'all_time' | 'custom';

export interface DateRange {
  /** Inclusive. Empty means open-ended, which only "all time" uses. */
  from: string;
  /** Inclusive. */
  to: string;
}

export const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'last_week', label: 'Last 7 days' },
  { value: 'last_month', label: 'Last 30 days' },
  { value: 'all_time', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
];

/** Shifts a calendar date by whole days without crossing into UTC. */
function shiftDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  return localDateValue(new Date(year, month - 1, day + days));
}

/**
 * The dates a preset covers, both ends inclusive.
 *
 * "Last 7 days" includes today, so it is the six days before it plus today
 * rather than the seven before it — a filter that excluded the current day
 * would hide the check-ins someone is most likely looking for.
 */
export function rangeForPreset(preset: DatePreset, today: string = localDateValue()): DateRange {
  switch (preset) {
    case 'last_week':
      return { from: shiftDays(today, -6), to: today };
    case 'last_month':
      return { from: shiftDays(today, -29), to: today };
    case 'all_time':
      // Both ends open. The server leaves the date filter off entirely rather
      // than inventing an earliest date the records would have to sit after.
      return { from: '', to: '' };
    case 'custom':
    case 'today':
    default:
      return { from: today, to: today };
  }
}

function formatShort(value: string): string {
  if (!value) return '';
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** What the trigger reads, so the active filter is legible without opening it. */
export function describeRange(preset: DatePreset, range: DateRange): string {
  if (preset !== 'custom') {
    return DATE_PRESETS.find((option) => option.value === preset)?.label || 'Today';
  }
  if (!range.from || !range.to) return 'Custom range';
  if (range.from === range.to) return formatShort(range.from);
  return `${formatShort(range.from)} – ${formatShort(range.to)}`;
}

/** True when the range is usable, so a half-filled custom range never queries. */
export function isCompleteRange(range: DateRange, preset: DatePreset): boolean {
  if (preset === 'all_time') return true;
  if (!range.from || !range.to) return false;
  return range.from <= range.to;
}

/**
 * The endpoint for a date range.
 *
 * A single day still uses the `date` parameter the endpoint has always
 * accepted, so the common case produces the same request it did before and
 * nothing about existing behaviour changes.
 */
export function attendanceRangePath(range: DateRange): string {
  if (!range.from && !range.to) {
    return `/api/v2/attendance/today?${new URLSearchParams({ from: '', to: '' }).toString()}`;
  }
  if (range.from && range.from === range.to) return attendancePath(range.from);
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  return `/api/v2/attendance/today?${params.toString()}`;
}

export function uniqueRecordValues<T>(
  records: T[],
  field: keyof T & string,
  selectedValue = '',
): string[] {
  const values = records.map((record) => record[field]).filter(Boolean).map(String);
  if (selectedValue) values.push(selectedValue);
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export interface AttendanceFilters {
  search?: string;
  role?: string;
  college?: string;
}

export function filterAttendanceRecords(
  records: AttendanceRecord[],
  { search = '', role = '', college = '' }: AttendanceFilters = {},
): AttendanceRecord[] {
  const term = search.trim().toLowerCase();
  return records.filter((record) => {
    if (role && record.instructor_role !== role) return false;
    if (college && record.college_name !== college) return false;
    if (!term) return true;
    return [
      record.instructor_name,
      record.instructor_role,
      record.college_name,
      record.location_coordinates,
      record.remarks,
    ].some((value) => String(value || '').toLowerCase().includes(term));
  });
}
