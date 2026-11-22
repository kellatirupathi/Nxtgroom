// Column sorting shared by the data tables (Daily Records, Instructors,
// Institutes, Users). A header click cycles ascending -> descending -> off.

export type SortDirection = 'asc' | 'desc';

export interface ColumnSort {
  key: string;
  direction: SortDirection;
}

export function nextColumnSort(current: ColumnSort | null, key: string): ColumnSort | null {
  if (!current || current.key !== key) return { key, direction: 'asc' };
  if (current.direction === 'asc') return { key, direction: 'desc' };
  return null;
}

export type SortValue = string | number | null | undefined;

function isMissing(value: SortValue): boolean {
  return value === null || value === undefined || value === '';
}

// Empty values always go last, whichever way the column is sorted.
export function sortRows<T>(rows: readonly T[], sort: ColumnSort | null, valueOf: (row: T, key: string) => SortValue): T[] {
  if (!sort) return [...rows];
  const sign = sort.direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: valueOf(row, sort.key) }))
    .sort((left, right) => {
      const leftMissing = isMissing(left.value);
      const rightMissing = isMissing(right.value);
      if (leftMissing || rightMissing) {
        if (leftMissing && rightMissing) return left.index - right.index;
        return leftMissing ? 1 : -1;
      }
      const compared = typeof left.value === 'number' && typeof right.value === 'number'
        ? left.value - right.value
        : String(left.value).localeCompare(String(right.value), undefined, { numeric: true, sensitivity: 'base' });
      return compared * sign || left.index - right.index;
    })
    .map(({ row }) => row);
}

export function timeValue(value: unknown): number | null {
  if (!value) return null;
  const time = new Date(value as string).getTime();
  return Number.isNaN(time) ? null : time;
}

export function textMatches(value: unknown, term: string): boolean {
  const needle = term.trim().toLowerCase();
  return !needle || String(value ?? '').toLowerCase().includes(needle);
}

export function uniqueValues(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
