/**
 * Daily report send times. The server stores them as 24-hour "HH:MM"; the
 * settings screen shows and edits them as a 12-hour time with AM or PM.
 */

export type Period = 'AM' | 'PM';

export interface TwelveHourTime {
  hour: number; // 1-12
  minute: number; // 0-59
  period: Period;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isSendTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

/** "13:00" -> { hour: 1, minute: 0, period: 'PM' }. */
export function toTwelveHour(value: string): TwelveHourTime {
  const [hour24, minute] = value.split(':').map(Number);
  return { hour: hour24 % 12 || 12, minute, period: hour24 >= 12 ? 'PM' : 'AM' };
}

/** { hour: 6, minute: 30, period: 'PM' } -> "18:30". */
export function toTwentyFourHour({ hour, minute, period }: TwelveHourTime): string {
  const hour24 = (hour % 12) + (period === 'PM' ? 12 : 0);
  return `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** "18:30" -> "6:30 PM". */
export function sendTimeLabel(value: string): string {
  const { hour, minute, period } = toTwelveHour(value);
  return `${hour}:${String(minute).padStart(2, '0')} ${period}`;
}

/** The first time not already chosen, for a newly added row. */
export function suggestedSendTime(taken: string[]): string {
  const candidates = ['13:00', '18:30', '10:00', '16:00', '12:00', '09:00', '20:00', '15:00'];
  return candidates.find((value) => !taken.includes(value)) ?? '09:00';
}

/** A time chosen twice, as its 12-hour label, or null. */
export function repeatedSendTime(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return sendTimeLabel(value);
    seen.add(value);
  }
  return null;
}

/** Sorted, the order the reports go out. */
export function sortedSendTimes(values: string[]): string[] {
  return [...values].sort();
}
