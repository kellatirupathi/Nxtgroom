import { csvCell } from '../attendanceExport.ts';
import { formatAttendanceTime, localDateValue, weekStartOf } from '../attendanceFilters.ts';
import { publicDayReportPath } from '../routes.ts';

/**
 * The Escalations page, opened from "View all" on the Dashboard: every run of
 * three or more non-compliant check-ins in a row in a week, one row per day.
 * The server finds the runs (the same rule that emails the reporting
 * partners); this module chooses the week and narrows what it returned.
 */

export type HalfVerdict = 'compliant' | 'non_compliant' | 'unassessed' | 'error' | 'pending' | 'no_photo';

export interface EscalationRow {
  attendance_id: string;
  instructor_id: string;
  name: string;
  role: string | null;
  college_id: string | null;
  institute: string;
  /** YYYY-MM-DD. */
  date: string;
  weekday: string;
  /** Which failed check-in of the run this is, and how long the run is. */
  run_day: number;
  run_length: number;
  run_start: string;
  check_in_time: string | null;
  check_in_status: HalfVerdict | string;
  check_in_remarks: string | null;
  check_out_time: string | null;
  /** Null when there was no check-out that day. */
  check_out_status: HalfVerdict | string | null;
  check_out_remarks: string | null;
  has_checkin_photo: boolean;
  has_checkout_photo: boolean;
  report_token: string | null;
}

export interface EscalationReport {
  week_start: string;
  week_end: string;
  rows: EscalationRow[];
  institutes: Array<{ id: string; name: string }>;
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export const VERDICT_LABELS: Record<string, string> = {
  compliant: 'Compliant',
  non_compliant: 'Non-compliant',
  unassessed: 'Not assessed',
  error: 'Analysis error',
  pending: 'Analysing',
  no_photo: 'No photo',
};

export type CheckoutFilter = '' | 'compliant' | 'non_compliant' | 'none';

export const CHECKOUT_FILTER_OPTIONS: ReadonlyArray<{ value: Exclude<CheckoutFilter, ''>; label: string }> = [
  { value: 'compliant', label: 'Check-out compliant' },
  { value: 'non_compliant', label: 'Check-out non-compliant' },
  { value: 'none', label: 'No check-out' },
];

export interface EscalationFilters {
  search?: string;
  college?: string;
  weekday?: string;
  checkout?: CheckoutFilter;
}

function shiftDays(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "21 Sep 2026" from a day key. Spelled out here, as browsers abbreviate months differently. */
export function dayLabel(dayKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match || !MONTHS[Number(match[2]) - 1]) return dayKey;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/** "21 – 27 Sep 2026", or "29 Sep – 5 Oct 2026" across a month. */
export function weekRangeLabel(weekStart: string): string {
  const end = shiftDays(weekStart, 6);
  const [startDay, startMonth] = dayLabel(weekStart).split(' ');
  return startMonth === dayLabel(end).split(' ')[1]
    ? `${startDay} – ${dayLabel(end)}`
    : `${startDay} ${startMonth} – ${dayLabel(end)}`;
}

/**
 * The weeks to choose from: this week first, then each earlier one. A week
 * chosen by date that is older than these is added so the menu can show it.
 */
export function weekOptions(today: string = localDateValue(), count = 12, selected?: string): Array<{ value: string; label: string }> {
  const thisWeek = weekStartOf(today);
  const options = Array.from({ length: count }, (_, index) => {
    const value = shiftDays(thisWeek, -7 * index);
    const prefix = index === 0 ? 'This week · ' : index === 1 ? 'Last week · ' : '';
    return { value, label: `${prefix}${weekRangeLabel(value)}` };
  });
  if (selected && !options.some((option) => option.value === selected)) {
    options.push({ value: selected, label: weekRangeLabel(selected) });
  }
  return options;
}

/** The rows a reader asked for: an instructor or institute name, an institute, a day, a check-out result. */
export function filterEscalationRows(rows: EscalationRow[], { search = '', college = '', weekday = '', checkout = '' }: EscalationFilters = {}): EscalationRow[] {
  const term = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (college && row.college_id !== college) return false;
    if (weekday && row.weekday !== weekday) return false;
    if (checkout === 'none' && row.check_out_status) return false;
    if ((checkout === 'compliant' || checkout === 'non_compliant') && row.check_out_status !== checkout) return false;
    if (term && ![row.name, row.institute, row.role].some((value) => String(value || '').toLowerCase().includes(term))) return false;
    return true;
  });
}

/** How many different instructors the rows are about. */
export function escalatedInstructorCount(rows: EscalationRow[]): number {
  return new Set(rows.map((row) => row.instructor_id)).size;
}

/** The public report for one half of a row, or null without a report link. */
export function rowReportPath(row: EscalationRow, half: 'checkin' | 'checkout'): string | null {
  if (!row.report_token) return null;
  if (half === 'checkout' && !row.check_out_time) return null;
  return publicDayReportPath(row.report_token, row.date, half);
}

export const ESCALATION_CSV_COLUMNS = [
  'Week',
  'Instructor Name',
  'Role',
  'Institute',
  'Date',
  'Day',
  'Escalation',
  'Check-in Time',
  'Check-in Result',
  'Check-out Time',
  'Check-out Result',
  'Check-in Report',
  'Check-out Report',
] as const;

/** The rows on screen as CSV, report links absolute so they open from a spreadsheet. */
export function escalationCsv(rows: EscalationRow[], weekStart: string, origin: string): string {
  const link = (path: string | null) => (path ? `${origin}${path}` : '');
  const lines = rows.map((row) => [
    weekRangeLabel(weekStart),
    row.name,
    row.role || '',
    row.institute,
    dayLabel(row.date),
    row.weekday,
    `Day ${row.run_day} of ${row.run_length} in a row`,
    row.check_in_time ? formatAttendanceTime(row.check_in_time) : '',
    VERDICT_LABELS[row.check_in_status] || row.check_in_status,
    row.check_out_time ? formatAttendanceTime(row.check_out_time) : '',
    row.check_out_status ? (VERDICT_LABELS[row.check_out_status] || row.check_out_status) : 'No check-out',
    link(rowReportPath(row, 'checkin')),
    link(rowReportPath(row, 'checkout')),
  ].map(csvCell).join(','));
  return [ESCALATION_CSV_COLUMNS.join(','), ...lines].join('\r\n');
}

export function escalationFileName(weekStart: string): string {
  return `escalations-week-${weekStart}.csv`;
}
