import { localDateValue } from '../attendanceFilters.ts';
import { publicDayReportPath } from '../routes.ts';
import { normalizeAttendanceStatus } from '../status.ts';
import type { AttendanceRecord, AttendanceStatus } from '../types.ts';

export type RecordsPeriod = 'last_10' | 'last_30' | 'last_90' | 'all' | 'custom';

export const RECORDS_PERIODS: ReadonlyArray<{ value: RecordsPeriod; label: string }> = [
  { value: 'last_10', label: 'Last 10 days' },
  { value: 'last_30', label: 'Last 30 days' },
  { value: 'last_90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
];

export const RECORDS_PAGE_PATH = '/instructors/records';

export function recordsPeriodFromParam(value: string | null | undefined): RecordsPeriod {
  return RECORDS_PERIODS.some((option) => option.value === value) ? value as RecordsPeriod : 'last_10';
}

export function recordsPagePath({ id, name }: { id: string; name: string }): string {
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (id) params.set('id', id);
  const search = params.toString();
  return search ? `${RECORDS_PAGE_PATH}?${search}` : RECORDS_PAGE_PATH;
}

export function recordsPeriodParams(period: RecordsPeriod, custom: { from: string; to: string }): Record<string, string | null> {
  return {
    period: period === 'last_10' ? null : period,
    from: period === 'custom' ? custom.from || null : null,
    to: period === 'custom' ? custom.to || null : null,
  };
}

export function matchInstructorsByName<T extends { name?: string | null }>(instructors: T[], name: string): T[] {
  const wanted = name.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!wanted) return [];
  return instructors.filter((instructor) => String(instructor.name ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === wanted);
}

export interface RecordsRange {
  from: string;
  to: string;
}

function shiftDays(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function recordsRange(period: RecordsPeriod, today: string = localDateValue(), custom?: RecordsRange): RecordsRange {
  switch (period) {
    case 'last_30':
      return { from: shiftDays(today, -29), to: today };
    case 'last_90':
      return { from: shiftDays(today, -89), to: today };
    case 'all':
      return { from: '', to: '' };
    case 'custom':
      return custom ?? { from: shiftDays(today, -9), to: today };
    case 'last_10':
    default:
      return { from: shiftDays(today, -9), to: today };
  }
}

export function recordsRangeProblem({ from, to }: RecordsRange): string {
  if (!from || !to) return 'Choose both a start and an end date.';
  if (from > to) return 'The start date must be on or before the end date.';
  return '';
}

export function recordsPath(instructorId: string, { from, to }: RecordsRange): string {
  const params = new URLSearchParams({ instructor_id: instructorId, from, to, limit: '1000' });
  return `/api/v2/attendance/today?${params.toString()}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function recordDay(record: AttendanceRecord): string {
  if (record.attendance_day) return record.attendance_day;
  const moment = record.check_in_time || record.date;
  return moment ? localDateValue(new Date(moment)) : '';
}

export function recordDayLabel(dayKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return dayKey || '--';
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday}, ${day} ${MONTHS[month - 1]} ${year}`;
}

export function rangeSummaryLabel({ from, to }: RecordsRange): string {
  if (!from && !to) return 'All time';
  const short = (key: string) => recordDayLabel(key).split(', ')[1] || key;
  return from === to ? short(from) : `${short(from)} – ${short(to)}`;
}

export function checkoutVerdict(record: AttendanceRecord): AttendanceStatus | null {
  if (!record.check_out_time) return null;
  return normalizeAttendanceStatus(record.checkout_compliance_status);
}

export function summarizeRecords(records: AttendanceRecord[]): { total: number; compliant: number; nonCompliant: number; checkedOut: number } {
  return {
    total: records.length,
    compliant: records.filter((record) => normalizeAttendanceStatus(record.status) === 'compliant').length,
    nonCompliant: records.filter((record) => normalizeAttendanceStatus(record.status) === 'non_compliant').length,
    checkedOut: records.filter((record) => Boolean(record.check_out_time)).length,
  };
}

export function recordReportPath(record: AttendanceRecord, half: 'checkin' | 'checkout'): string | null {
  if (!record.report_token) return null;
  if (half === 'checkout' && !record.check_out_time) return null;
  const day = recordDay(record);
  return day ? publicDayReportPath(record.report_token, day, half) : null;
}

export function sortRecordsNewestFirst(records: AttendanceRecord[]): AttendanceRecord[] {
  return [...records].sort((left, right) => String(right.check_in_time || right.date || '').localeCompare(String(left.check_in_time || left.date || '')));
}
