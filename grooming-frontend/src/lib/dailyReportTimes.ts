export type Period = 'AM' | 'PM';

export interface TwelveHourTime {
  hour: number;
  minute: number;
  period: Period;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isSendTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

export function toTwelveHour(value: string): TwelveHourTime {
  const [hour24, minute] = value.split(':').map(Number);
  return { hour: hour24 % 12 || 12, minute, period: hour24 >= 12 ? 'PM' : 'AM' };
}

export function toTwentyFourHour({ hour, minute, period }: TwelveHourTime): string {
  const hour24 = (hour % 12) + (period === 'PM' ? 12 : 0);
  return `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function sendTimeLabel(value: string): string {
  const { hour, minute, period } = toTwelveHour(value);
  return `${hour}:${String(minute).padStart(2, '0')} ${period}`;
}

export function suggestedSendTime(taken: string[]): string {
  const candidates = ['13:00', '18:30', '10:00', '16:00', '12:00', '09:00', '20:00', '15:00'];
  return candidates.find((value) => !taken.includes(value)) ?? '09:00';
}

export function repeatedSendTime(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return sendTimeLabel(value);
    seen.add(value);
  }
  return null;
}

export function sortedSendTimes(values: string[]): string[] {
  return [...values].sort();
}
