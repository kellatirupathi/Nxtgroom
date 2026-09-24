import {
  attendanceSessionDateLabel,
  checkoutDateTimeLabel,
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

/**
 * Hands the file to the browser.
 *
 * The byte-order mark is what makes Excel read the file as UTF-8, without which
 * a name in Telugu or Hindi opens as mojibake.
 */
export function downloadAttendanceCsv(records: AttendanceRecord[], range: DateRange): void {
  const blob = new Blob([`﻿${attendanceCsv(records)}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = attendanceExportFileName(range);
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: revoking synchronously cancels the download in
  // some browsers before it has started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
