import { csvCell } from '../attendanceExport.ts';

export type DayStatus = 'compliant' | 'non_compliant' | 'pending' | 'unassessed' | 'error';

export interface DayRow {
  attendance_id: string;
  date: string;
  name: string;
  institute: string;
  status: DayStatus;
  check_in: string;
  check_out: string;
  feedback: string;
  has_checkin_photo: boolean;
  has_checkout_photo: boolean;
  checkin_report_url: string | null;
  checkout_report_url: string | null;
}

export interface DayReportResponse {
  title: string;
  date_label: string;
  window_label: string;
  expires_at: string;
  rows: DayRow[];
}

export const DAY_STATUS_LABELS: Record<DayStatus, string> = {
  compliant: 'Compliant',
  non_compliant: 'Non-compliant',
  pending: 'Analysis in progress',
  unassessed: 'Not assessed',
  error: 'Analysis failed',
};

export const DAY_STATUS_OPTIONS = (Object.keys(DAY_STATUS_LABELS) as DayStatus[])
  .map((value) => ({ value, label: DAY_STATUS_LABELS[value] }));

export interface DayFilters {
  search?: string;
  institute?: string;
  status?: DayStatus | '';
}

export function filterDayRows(rows: DayRow[], { search = '', institute = '', status = '' }: DayFilters = {}): DayRow[] {
  const term = search.trim().toLowerCase();
  return rows.filter((row) => (
    (!term || row.name.toLowerCase().includes(term))
    && (!institute || row.institute === institute)
    && (!status || row.status === status)
  ));
}

export function dayInstitutes(rows: DayRow[]): string[] {
  return [...new Set(rows.map((row) => row.institute).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

const COLUMNS: ReadonlyArray<[string, (row: DayRow) => unknown]> = [
  ['Date', (row) => row.date],
  ['Instructor Name', (row) => row.name],
  ['Institute', (row) => row.institute],
  ['Status', (row) => DAY_STATUS_LABELS[row.status] ?? ''],
  ['Check-in Time', (row) => (row.check_in === '-' ? '' : row.check_in)],
  ['Check-out Time', (row) => (row.check_out === '-' ? '' : row.check_out)],
  ['Feedback', (row) => row.feedback],
  ['Check-in Report', (row) => row.checkin_report_url],
  ['Check-out Report', (row) => row.checkout_report_url],
];

export function dayReportCsv(rows: DayRow[]): string {
  const header = COLUMNS.map(([title]) => csvCell(title)).join(',');
  return [header, ...rows.map((row) => COLUMNS.map(([, read]) => csvCell(read(row))).join(','))].join('\r\n');
}

export function dayReportFileName(dateLabel: string): string {
  const [day, month, year] = String(dateLabel).split('/');
  return year && month && day ? `daily-report-${year}-${month}-${day}.csv` : 'daily-report.csv';
}

export function dayReportApiPath(reportUrl: string): string | null {
  try {
    const match = new URL(reportUrl).pathname.match(/^\/daily-report\/(\d{2}-\d{2}-\d{4})\/([A-Za-z0-9_-]{16,128})\/?$/);
    return match ? `/api/v2/reports/daily/${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}
