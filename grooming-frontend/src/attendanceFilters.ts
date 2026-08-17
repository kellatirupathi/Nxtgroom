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
