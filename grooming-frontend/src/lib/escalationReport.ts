import { csvCell } from '../attendanceExport.ts';
import { formatAttendanceTime, localDateValue, weekStartOf } from '../attendanceFilters.ts';
import { publicDayReportPath } from '../routes.ts';

export type HalfVerdict = 'compliant' | 'non_compliant' | 'unassessed' | 'error' | 'pending' | 'no_photo';

export interface EscalationRow {
  attendance_id: string;
  instructor_id: string;
  name: string;
  role: string | null;
  college_id: string | null;
  institute: string;
  date: string;
  weekday: string;
  run_day: number;
  run_length: number;
  run_start: string;
  check_in_time: string | null;
  check_in_status: HalfVerdict | string;
  check_in_remarks: string | null;
  check_out_time: string | null;
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

export type EscalationPeriod = 'this_week' | 'last_week' | 'this_month' | 'custom';

export const ESCALATION_PERIODS: ReadonlyArray<{ value: EscalationPeriod; label: string }> = [
  { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'this_month', label: 'This month' },
  { value: 'custom', label: 'Custom range' },
];

export const MAX_RANGE_DAYS = 93;

export interface PeriodRange {
  from: string;
  to: string;
}

function shiftDays(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

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

export function rangeProblem({ from, to }: PeriodRange): string {
  if (!from || !to) return 'Choose both a start and an end date.';
  if (from > to) return 'The start date must be on or before the end date.';
  if (shiftDays(from, MAX_RANGE_DAYS - 1) < to) return `Choose a range of at most ${MAX_RANGE_DAYS} days.`;
  return '';
}

export function escalationsPath({ from, to }: PeriodRange): string {
  return `/api/v2/dashboard/escalations?${new URLSearchParams({ from, to }).toString()}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayLabel(dayKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match || !MONTHS[Number(match[2]) - 1]) return dayKey;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

export function shortDayLabel(dayKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match || !MONTHS[Number(match[2]) - 1]) return dayKey;
  const weekday = SHORT_WEEKDAYS[new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()];
  return `${weekday} ${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
}

export function rangeLabel(from: string, to: string): string {
  if (from === to) return dayLabel(from);
  const [startDay, startMonth, startYear] = dayLabel(from).split(' ');
  const [, endMonth, endYear] = dayLabel(to).split(' ');
  if (startYear !== endYear) return `${dayLabel(from)} – ${dayLabel(to)}`;
  if (startMonth !== endMonth) return `${startDay} ${startMonth} – ${dayLabel(to)}`;
  return `${startDay} – ${dayLabel(to)}`;
}

export interface EscalationFilters {
  search?: string;
  college?: string;
  weekday?: string;
}

export function filterEscalationRows(rows: EscalationRow[], { search = '', college = '', weekday = '' }: EscalationFilters = {}): EscalationRow[] {
  const term = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (college && row.college_id !== college) return false;
    if (weekday && row.weekday !== weekday) return false;
    if (term && ![row.name, row.institute, row.role].some((value) => String(value || '').toLowerCase().includes(term))) return false;
    return true;
  });
}

export interface EscalatedPerson {
  instructor_id: string;
  name: string;
  role: string | null;
  institute: string;
  college_id: string | null;
  days: EscalationRow[];
}

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

export function runsOf(days: EscalationRow[]): Array<{ run_start: string; run_length: number; days: EscalationRow[] }> {
  const runs = new Map<string, { run_start: string; run_length: number; days: EscalationRow[] }>();
  for (const day of days) {
    const run = runs.get(day.run_start);
    if (run) run.days.push(day);
    else runs.set(day.run_start, { run_start: day.run_start, run_length: day.run_length, days: [day] });
  }
  return [...runs.values()].sort((left, right) => left.run_start.localeCompare(right.run_start));
}

export function rowReportPath(row: EscalationRow, half: 'checkin' | 'checkout'): string | null {
  if (!row.report_token) return null;
  if (half === 'checkout' && !row.check_out_time) return null;
  return publicDayReportPath(row.report_token, row.date, half);
}

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
