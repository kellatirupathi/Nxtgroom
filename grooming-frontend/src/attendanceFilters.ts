import type { AttendanceEscalation, AttendanceRecord, AttendanceStatus } from './types.ts';
import { normalizeAttendanceStatus } from './status.ts';

export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

export function localDateValue(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function formatAttendanceTime(value?: string | Date | null): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: BUSINESS_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatAttendanceDate(value?: string | Date | null): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: BUSINESS_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export function attendanceSessionDateLabel(
  checkIn?: string | Date | null,
  checkOut?: string | Date | null,
  fallbackDate?: string | Date | null,
): string {
  const start = checkIn || fallbackDate;
  if (!start) return '--';
  if (checkOut && localDateValue(new Date(start)) !== localDateValue(new Date(checkOut))) {
    return `${formatAttendanceDate(start)} – ${formatAttendanceDate(checkOut)}`;
  }
  return formatAttendanceDate(start);
}

export function checkoutDateTimeLabel(
  checkIn?: string | Date | null,
  checkOut?: string | Date | null,
  checkoutStatus?: string | null,
): string {
  if (!checkOut) {
    return checkoutStatus === 'not_checked_out' ? 'Not checked out' : '--';
  }
  if (checkIn) {
    const checkInKey = localDateValue(new Date(checkIn));
    const checkOutKey = localDateValue(new Date(checkOut));
    if (checkInKey !== checkOutKey) {
      const [startYear, startMonth, startDay] = checkInKey.split('-').map(Number);
      const [endYear, endMonth, endDay] = checkOutKey.split('-').map(Number);
      const dayDifference = Math.round(
        (Date.UTC(endYear, endMonth - 1, endDay) - Date.UTC(startYear, startMonth - 1, startDay))
        / 86_400_000,
      );
      const differenceLabel = dayDifference > 0
        ? `+${dayDifference} ${dayDifference === 1 ? 'day' : 'days'}`
        : `${dayDifference} ${dayDifference === -1 ? 'day' : 'days'}`;
      return `${formatAttendanceDate(checkOut)}, ${formatAttendanceTime(checkOut)} (${differenceLabel})`;
    }
  }
  return formatAttendanceTime(checkOut);
}

export function attendancePath(date?: string | null): string {
  if (!date) return '/api/v2/attendance/today';
  return `/api/v2/attendance/today?${new URLSearchParams({ date }).toString()}`;
}

export type DatePreset = 'today' | 'last_week' | 'last_month' | 'all_time' | 'custom';

export interface DateRange {
  from: string;
  to: string;
}

export const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'last_week', label: 'Last 7 days' },
  { value: 'last_month', label: 'Last 30 days' },
  { value: 'all_time', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
];

function shiftDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function rangeForPreset(preset: DatePreset, today: string = localDateValue()): DateRange {
  switch (preset) {
    case 'last_week':
      return { from: shiftDays(today, -6), to: today };
    case 'last_month':
      return { from: shiftDays(today, -29), to: today };
    case 'all_time':
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

export function describeRange(preset: DatePreset, range: DateRange): string {
  if (preset !== 'custom') {
    return DATE_PRESETS.find((option) => option.value === preset)?.label || 'Today';
  }
  if (!range.from || !range.to) return 'Custom range';
  if (range.from === range.to) return formatShort(range.from);
  return `${formatShort(range.from)} – ${formatShort(range.to)}`;
}

export function isCompleteRange(range: DateRange, preset: DatePreset): boolean {
  if (preset === 'all_time') return true;
  if (!range.from || !range.to) return false;
  return range.from <= range.to;
}

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
  status?: AttendanceStatus | '';
  escalation?: EscalationFilter;
}

export const ESCALATION_THRESHOLD = 3;

export type EscalationFilter = '' | 'escalated' | 'not_escalated';

export const ESCALATION_FILTER_OPTIONS: ReadonlyArray<{ value: Exclude<EscalationFilter, ''>; label: string }> = [
  { value: 'escalated', label: 'Escalated (3+ check-in days in a row)' },
  { value: 'not_escalated', label: 'Not escalated' },
];

export function isEscalated(escalation: AttendanceEscalation | null | undefined): boolean {
  return (escalation?.count ?? 0) >= ESCALATION_THRESHOLD;
}

export function weekStartOf(dayKey: string): string {
  const [year, month, day] = String(dayKey).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function shortDay(dayKey: string, withYear = false): string {
  const date = new Date(`${dayKey}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(dayKey);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

export function escalationLabel(
  escalation: AttendanceEscalation | null | undefined,
  today: string = localDateValue(),
): { text: string; title: string } | null {
  if (!escalation || !isEscalated(escalation)) return null;
  const thisWeek = escalation.week_start === weekStartOf(today);
  const range = `${shortDay(escalation.week_start)} - ${shortDay(escalation.week_end, true)}`;
  if (!escalation.streak) {
    return {
      text: `Escalated · ${escalation.count}× ${thisWeek ? 'this week' : 'that week'}`,
      title: `Escalated: non-compliant ${escalation.count} times in the week of ${range}`,
    };
  }
  return {
    text: `Escalated · ${escalation.count} days in a row`,
    title: `Escalated: non-compliant at check-in on ${escalation.count} days in a row in the week of ${range}`,
  };
}

export function spreadEscalation(rows: AttendanceRecord[]): AttendanceRecord[] {
  const keyOf = (row: AttendanceRecord) => (
    row.instructor_id && row.attendance_day ? `${row.instructor_id}|${weekStartOf(row.attendance_day)}` : null
  );
  const freshest = new Map<string, { at: number; escalation: AttendanceEscalation | null }>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const at = new Date(row.updated_at || 0).getTime() || 0;
    const current = freshest.get(key);
    if (!current || at > current.at) freshest.set(key, { at, escalation: row.escalation ?? null });
  }
  return rows.map((row) => {
    const key = keyOf(row);
    const source = key ? freshest.get(key) : undefined;
    if (!source) return row;
    const unchanged = JSON.stringify(row.escalation ?? null) === JSON.stringify(source.escalation);
    return unchanged ? row : { ...row, escalation: source.escalation };
  });
}

export const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: AttendanceStatus; label: string }> = [
  { value: 'compliant', label: 'Compliant' },
  { value: 'non_compliant', label: 'Non-compliant' },
  { value: 'unassessed', label: 'Not assessed' },
  { value: 'pending', label: 'Pending AI' },
  { value: 'error', label: 'Analysis error' },
];

export function statusLabel(status: unknown): string {
  const normalized = normalizeAttendanceStatus(status);
  return STATUS_FILTER_OPTIONS.find((option) => option.value === normalized)?.label || 'Pending AI';
}

export function filterAttendanceRecords(
  records: AttendanceRecord[],
  { search = '', role = '', college = '', status = '', escalation = '' }: AttendanceFilters = {},
): AttendanceRecord[] {
  const term = search.trim().toLowerCase();
  return records.filter((record) => {
    if (record.status === 'unidentified') return false;
    if (role && record.instructor_role !== role) return false;
    if (college && record.college_name !== college) return false;
    if (status && normalizeAttendanceStatus(record.status) !== status) return false;
    if (escalation === 'escalated' && !isEscalated(record.escalation)) return false;
    if (escalation === 'not_escalated' && isEscalated(record.escalation)) return false;
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

export interface SavedRecordsFilters {
  preset: DatePreset;
  range: DateRange;
  search: string;
  college: string;
  role: string;
  status: AttendanceStatus | '';
  escalation: EscalationFilter;
}

export const RECORDS_FILTERS_KEY = 'facultytrack:daily-records-filters';

const PRESETS: readonly DatePreset[] = ['today', 'last_week', 'last_month', 'all_time', 'custom'];
const STATUSES: readonly string[] = ['compliant', 'non_compliant', 'unassessed', 'error', 'pending'];
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function tabStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function defaultRecordsFilters(today: string = localDateValue()): SavedRecordsFilters {
  return { preset: 'today', range: rangeForPreset('today', today), search: '', college: '', role: '', status: '', escalation: '' };
}

export function loadRecordsFilters(
  storage: Pick<Storage, 'getItem'> | null = tabStorage(),
  today: string = localDateValue(),
): SavedRecordsFilters {
  const fallback = defaultRecordsFilters(today);
  let saved: Record<string, unknown>;
  try {
    const raw = storage?.getItem(RECORDS_FILTERS_KEY);
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    return fallback;
  }
  if (!saved || typeof saved !== 'object') return fallback;

  const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
  const preset = PRESETS.includes(saved.preset as DatePreset) ? (saved.preset as DatePreset) : 'today';
  const savedRange = saved.range as Partial<DateRange> | undefined;
  const customRange = preset === 'custom'
    && typeof savedRange?.from === 'string' && DAY_KEY.test(savedRange.from)
    && typeof savedRange?.to === 'string' && DAY_KEY.test(savedRange.to)
    ? { from: savedRange.from, to: savedRange.to }
    : null;
  return {
    preset: preset === 'custom' && !customRange ? 'today' : preset,
    range: customRange || rangeForPreset(preset === 'custom' ? 'today' : preset, today),
    search: text(saved.search, 120),
    college: text(saved.college, 200),
    role: text(saved.role, 200),
    status: STATUSES.includes(saved.status as string) ? (saved.status as AttendanceStatus) : '',
    escalation: saved.escalation === 'escalated' || saved.escalation === 'not_escalated' ? saved.escalation : '',
  };
}

export function saveRecordsFilters(
  filters: SavedRecordsFilters,
  storage: Pick<Storage, 'setItem'> | null = tabStorage(),
): void {
  try {
    storage?.setItem(RECORDS_FILTERS_KEY, JSON.stringify(filters));
  } catch {
  }
}
