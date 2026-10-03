import {
  attendanceSessionDateLabel,
  checkoutDateTimeLabel,
  escalationLabel,
  formatAttendanceTime,
  statusLabel,
  type DateRange,
} from './attendanceFilters.ts';
import { formatCoordinates } from './status.ts';
import type { AttendanceRecord } from './types.ts';

const ATTIRE_LABELS: Record<string, string> = {
  FORMAL: 'Formal',
  SAREE: 'Saree',
  KURTI_WITH_DUPATTA: 'Kurti + Dupatta',
  ABAYA: 'Abaya',
  KURTA_PAJAMA: 'Kurta + Payjama',
};

const COLUMNS: ReadonlyArray<[string, (record: AttendanceRecord) => unknown]> = [
  ['Instructor Name', (record) => record.instructor_name],
  ['Role', (record) => record.instructor_role],
  ['Institute', (record) => record.college_name],
  ['Date', (record) => attendanceSessionDateLabel(record.check_in_time, record.check_out_time, record.date)],
  ['Check-In', (record) => formatAttendanceTime(record.check_in_time)],
  ['Check-Out', (record) => checkoutDateTimeLabel(record.check_in_time, record.check_out_time, record.checkout_status)],
  ['Coordinates', (record) => (record.location_coordinates ? formatCoordinates(record.location_coordinates) : '')],
  ['Status', (record) => statusLabel(record.status)],
  ['Escalation', (record) => escalationLabel(record.escalation)?.title ?? ''],
  ['Attire', (record) => (record.attire_type ? ATTIRE_LABELS[record.attire_type] || '' : '')],
  ['Remark', (record) => record.remarks],
];

export function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (text === '--') text = '';
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function attendanceCsv(records: AttendanceRecord[]): string {
  const header = COLUMNS.map(([title]) => csvCell(title)).join(',');
  const rows = records.map((record) => COLUMNS.map(([, read]) => csvCell(read(record))).join(','));
  return [header, ...rows].join('\r\n');
}

export function attendanceExportFileName(range: DateRange): string {
  const from = range.from || 'all';
  const to = range.to || from;
  return from === to
    ? `daily-attendance-${from}.csv`
    : `daily-attendance-${from}_to_${to}.csv`;
}

interface CapacitorBridge {
  getPlatform?: () => string;
  nativePromise?: (plugin: string, method: string, options: Record<string, unknown>) => Promise<unknown>;
}

export function androidAppBridge(scope: { Capacitor?: CapacitorBridge } = globalThis as never): CapacitorBridge | null {
  const bridge = scope.Capacitor;
  return bridge?.getPlatform?.() === 'android' && typeof bridge.nativePromise === 'function' ? bridge : null;
}

export function saveCsvFile(fileName: string, csv: string): Promise<void> {
  const content = `\uFEFF${csv}`;
  const app = androidAppBridge();
  if (app?.nativePromise) {
    return app.nativePromise('FileSaver', 'saveText', { fileName, mimeType: 'text/csv', content }).then(() => undefined);
  }
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return Promise.resolve();
}

export function downloadAttendanceCsv(records: AttendanceRecord[], range: DateRange): Promise<void> {
  return saveCsvFile(attendanceExportFileName(range), attendanceCsv(records));
}
