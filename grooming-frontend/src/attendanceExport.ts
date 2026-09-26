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

/**
 * The Daily Records table as a spreadsheet.
 *
 * Exactly the rows on screen, in the words on screen: every value goes through
 * the formatter its column uses, so the file and the table cannot disagree
 * about a time zone, a session that crossed midnight, or what a status means.
 * The photo and report columns are left out - they are buttons, not data.
 */

const ATTIRE_LABELS: Record<string, string> = {
  FORMAL: 'Formal',
  SAREE: 'Saree',
  KURTI_WITH_DUPATTA: 'Kurti + Dupatta',
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
  // The dated sentence, not the table's "this week", which a file opened next
  // month would get wrong.
  ['Escalation', (record) => escalationLabel(record.escalation)?.title ?? ''],
  ['Attire', (record) => (record.attire_type ? ATTIRE_LABELS[record.attire_type] || '' : '')],
  ['Remark', (record) => record.remarks],
];

/**
 * One CSV cell.
 *
 * A value a spreadsheet would read as a formula is prefixed with a quote.
 * Names and remarks are typed by people, and a remark beginning with "=" or
 * "@" would otherwise run as a formula on whoever opens the file.
 */
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

/** Names the file after the dates it covers, so two exports never look alike. */
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

/**
 * The Android app's bridge, when the page is running inside the app.
 *
 * The app injects `window.Capacitor` into the page; the website never has it.
 */
export function androidAppBridge(scope: { Capacitor?: CapacitorBridge } = globalThis as never): CapacitorBridge | null {
  const bridge = scope.Capacitor;
  return bridge?.getPlatform?.() === 'android' && typeof bridge.nativePromise === 'function' ? bridge : null;
}

/**
 * Hands the file to the browser, or to the Android app.
 *
 * The byte-order mark is what makes Excel read the file as UTF-8, without which
 * a name in Telugu or Hindi opens as mojibake.
 *
 * In the app a blob link does nothing - its WebView has no download manager -
 * so the app saves the file itself, to Downloads, and says so.
 */
export function downloadAttendanceCsv(records: AttendanceRecord[], range: DateRange): Promise<void> {
  const content = `﻿${attendanceCsv(records)}`;
  const fileName = attendanceExportFileName(range);
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
  // Revoked on the next tick: revoking synchronously cancels the download in
  // some browsers before it has started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return Promise.resolve();
}
