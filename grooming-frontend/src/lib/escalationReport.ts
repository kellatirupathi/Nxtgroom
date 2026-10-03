import { csvCell } from '../attendanceExport.ts';
import { formatAttendanceTime, localDateValue, weekStartOf } from '../attendanceFilters.ts';
import { publicDayReportPath } from '../routes.ts';

/**
 * The Escalations page, opened from "View all" on the Dashboard: everyone
 * whose check-in was non-compliant three or more times in a row in a week,
 * one row per person, for this week, last week, this month or a custom range.
 * The server finds the runs (the same rule that emails the reporting
 * partners) and returns one row per failed day; this module chooses the dates,
 * narrows the rows and gathers each person's days together.
 */

export type HalfVerdict = 'compliant' | 'non_compliant' | 'unassessed' | 'error' | 'pending' | 'no_photo';

/** One failed day of an escalated run, as the server returns it. */
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
  from: string;
  to: string;
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

// ---- The dates -----------------------------------------------------------------

export type EscalationPeriod = 'this_week' | 'last_week' | 'this_month' | 'custom';

export const ESCALATION_PERIODS: ReadonlyArray<{ value: EscalationPeriod; label: string }> = [
  { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'this_month', label: 'This month' },
  { value: 'custom', label: 'Custom range' },
];

/** The longest custom range the server will read, in days. */
export const MAX_RANGE_DAYS = 93;

export interface PeriodRange {
  /** YYYY-MM-DD, included. */
  from: string;
  /** YYYY-MM-DD, included. */
  to: string;
}

function shiftDays(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * The dates a period covers. Weeks run Monday to Sunday, as escalations do;
 * a month is the whole calendar month. `custom` is the range chosen.
 */
export function periodRange(period: EscalationPeriod, today: string = localDateValue(), custom?: PeriodRange): PeriodRange {
  switch (period) {
    case 'last_week': {
      const start = shiftDays(weekStartOf(today), -7);
      return { from: start, to: shiftDays(start, 6) };
    }
    case 'this_month': {
      const [year, month] = today.split('-').map(Number);
      return {
        from: `${today.slice(0, 7)}-01`,
        to: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
      };
    }
    case 'custom':
      if (custom) return custom;
      return periodRange('this_week', today);
    case 'this_week':
    default: {
      const start = weekStartOf(today);
      return { from: start, to: shiftDays(start, 6) };
    }
  }
}

/** Why a custom range cannot be shown, or '' when it can. */
export function rangeProblem({ from, to }: PeriodRange): string {
  if (!from || !to) return 'Choose both a start and an end date.';
  if (from > to) return 'The start date must be on or before the end date.';
  if (shiftDays(from, MAX_RANGE_DAYS - 1) < to) return `Choose a range of at most ${MAX_RANGE_DAYS} days.`;
  return '';
}

/** The request for a range of dates. */
export function escalationsPath({ from, to }: PeriodRange): string {
  return `/api/v2/dashboard/escalations?${new URLSearchParams({ from, to }).toString()}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "21 Sep 2026" from a day key. Spelled out here, as browsers abbreviate months differently. */
export function dayLabel(dayKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match || !MONTHS[Number(match[2]) - 1]) return dayKey;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/** "Tue 29 Sep", for a date inside the table. */
export function shortDayLabel(dayKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match || !MONTHS[Number(match[2]) - 1]) return dayKey;
  const weekday = SHORT_WEEKDAYS[new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()];
  return `${weekday} ${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
}

/** "21 – 27 Sep 2026", "29 Sep – 5 Oct 2026", "29 Dec 2025 – 4 Jan 2026" or one day. */
export function rangeLabel(from: string, to: string): string {
  if (from === to) return dayLabel(from);
  const [startDay, startMonth, startYear] = dayLabel(from).split(' ');
  const [, endMonth, endYear] = dayLabel(to).split(' ');
  if (startYear !== endYear) return `${dayLabel(from)} – ${dayLabel(to)}`;
  if (startMonth !== endMonth) return `${startDay} ${startMonth} – ${dayLabel(to)}`;
  return `${startDay} – ${dayLabel(to)}`;
}

// ---- The rows ------------------------------------------------------------------

export interface EscalationFilters {
  search?: string;
  college?: string;
  weekday?: string;
}

/** The failed days a reader asked for: an instructor or institute name, an institute, a weekday. */
export function filterEscalationRows(rows: EscalationRow[], { search = '', college = '', weekday = '' }: EscalationFilters = {}): EscalationRow[] {
  const term = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (college && row.college_id !== college) return false;
    if (weekday && row.weekday !== weekday) return false;
    if (term && ![row.name, row.institute, row.role].some((value) => String(value || '').toLowerCase().includes(term))) return false;
    return true;
  });
}

/** One escalated person and their failed days, oldest first. */
export interface EscalatedPerson {
  instructor_id: string;
  name: string;
  role: string | null;
  institute: string;
  college_id: string | null;
  days: EscalationRow[];
}

/**
 * One entry per person, in the order the server sorted them (by name), each
 * with their days by date. The name, role and institute are the latest day's,
 * as they are whatever the record said that day.
 */
export function groupByPerson(rows: EscalationRow[]): EscalatedPerson[] {
  const people = new Map<string, EscalatedPerson>();
  for (const row of rows) {
    const person = people.get(row.instructor_id);
    if (person) person.days.push(row);
    else people.set(row.instructor_id, { instructor_id: row.instructor_id, name: row.name, role: row.role, institute: row.institute, college_id: row.college_id, days: [row] });
  }
  return [...people.values()].map((person) => {
    const days = [...person.days].sort((left, right) => left.date.localeCompare(right.date));
    const latest = days[days.length - 1];
    return { ...person, name: latest.name, role: latest.role, institute: latest.institute, college_id: latest.college_id, days };
  });
}

/** A person's days split into their runs, each run's days by date. */
export function runsOf(days: EscalationRow[]): Array<{ run_start: string; run_length: number; days: EscalationRow[] }> {
  const runs = new Map<string, { run_start: string; run_length: number; days: EscalationRow[] }>();
  for (const day of days) {
    const run = runs.get(day.run_start);
    if (run) run.days.push(day);
    else runs.set(day.run_start, { run_start: day.run_start, run_length: day.run_length, days: [day] });
  }
  return [...runs.values()].sort((left, right) => left.run_start.localeCompare(right.run_start));
}

/** The public report for one half of a day, or null without a report link. */
export function rowReportPath(row: EscalationRow, half: 'checkin' | 'checkout'): string | null {
  if (!row.report_token) return null;
  if (half === 'checkout' && !row.check_out_time) return null;
  return publicDayReportPath(row.report_token, row.date, half);
}

// ---- Export --------------------------------------------------------------------

export const ESCALATION_CSV_COLUMNS = [
  'Period',
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

/** The failed days on screen as CSV, one line each, report links absolute so they open from a spreadsheet. */
export function escalationCsv(rows: EscalationRow[], range: PeriodRange, origin: string): string {
  const link = (path: string | null) => (path ? `${origin}${path}` : '');
  const lines = rows.map((row) => [
    rangeLabel(range.from, range.to),
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

export function escalationFileName({ from, to }: PeriodRange): string {
  return from === to ? `escalations-${from}.csv` : `escalations-${from}-to-${to}.csv`;
}
