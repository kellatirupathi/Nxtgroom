export const TABS = {
  DASHBOARD: 'dashboard',
  INSTITUTES: 'institutes',
  OVERVIEW: 'overview',
  DAILY_RECORDS: 'daily-records',
  INSTRUCTOR_DETAIL: 'instructor-detail',
  INSTRUCTORS: 'instructor-management',
  USERS: 'boa-management',
  SETTINGS: 'settings',
  ESCALATIONS: 'escalations',
} as const;

export type Tab = (typeof TABS)[keyof typeof TABS];

const TAB_TO_PATH: Record<Tab, string> = {
  [TABS.DASHBOARD]: '/dashboard',
  [TABS.INSTITUTES]: '/institutes',
  [TABS.OVERVIEW]: '/attendance',
  [TABS.DAILY_RECORDS]: '/daily-records',
  [TABS.INSTRUCTOR_DETAIL]: '/daily-records/record',
  [TABS.INSTRUCTORS]: '/instructors',
  [TABS.USERS]: '/users',
  [TABS.SETTINGS]: '/settings',
  [TABS.ESCALATIONS]: '/dashboard/escalations',
};

const PATH_TO_TAB = new Map<string, Tab>(
  Object.entries(TAB_TO_PATH).map(([tab, path]) => [path, tab as Tab]),
);

export const RESET_PASSWORD_PATH = '/reset-password';

export interface PublicReportRoute {
  token: string;
  kind: 'day' | 'week';
  date: string;
  half: 'checkin' | 'checkout';
}

export function halfSegment(half: 'checkin' | 'checkout'): string {
  return half === 'checkout' ? 'check-out' : 'check-in';
}

export function publicDayReportPath(token: string, date: string, half: 'checkin' | 'checkout'): string {
  return `/reports/${encodeURIComponent(token)}/day/${date}/${halfSegment(half)}`;
}

export function publicReportFromLocation(): PublicReportRoute | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(
    /^\/reports\/([A-Za-z0-9_-]{8,128})\/(day|week)\/(\d{4}-\d{2}-\d{2})(?:\/(check-in|check-out))?\/?$/,
  );
  if (!match) return null;
  return {
    token: match[1],
    kind: match[2] as 'day' | 'week',
    date: match[3],
    half: match[4] === 'check-out' ? 'checkout' : 'checkin',
  };
}

export interface DailyReportRoute {
  date: string;
  token: string;
}

export function dailyReportFromLocation(): DailyReportRoute | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(
    /^\/daily-report\/(\d{2}-\d{2}-\d{4})\/([A-Za-z0-9_-]{16,128})\/?$/,
  );
  if (!match) return null;
  return { date: match[1], token: match[2] };
}

export function pathForTab(tab: string, recordId?: string): string {
  const base = TAB_TO_PATH[tab as Tab] ?? TAB_TO_PATH[TABS.OVERVIEW];
  if (tab === TABS.INSTRUCTOR_DETAIL && recordId) {
    return `${base}/${encodeURIComponent(recordId)}`;
  }
  return base;
}

export function recordIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(/^\/daily-records\/record\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function tabForPath(pathname: string): Tab {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized === '/' || normalized === '') return TABS.OVERVIEW;
  if (/^\/daily-records\/record(\/|$)/.test(normalized)) return TABS.INSTRUCTOR_DETAIL;
  return PATH_TO_TAB.get(normalized) ?? TABS.OVERVIEW;
}

export function homeTabForRole(elevated: boolean): Tab {
  return elevated ? TABS.DASHBOARD : TABS.OVERVIEW;
}

export function currentTabFromLocation(): Tab {
  if (typeof window === 'undefined') return TABS.OVERVIEW;
  return tabForPath(window.location.pathname);
}

export function pushTabPath(tab: string, recordId?: string): void {
  if (typeof window === 'undefined') return;
  const path = pathForTab(tab, recordId);
  if (window.location.pathname === path) return;
  window.history.pushState({ tab }, '', path);
}

export function replaceTabPath(tab: string, recordId?: string): void {
  if (typeof window === 'undefined') return;
  const path = pathForTab(tab, recordId);
  if (window.location.pathname === path) return;
  window.history.replaceState({ tab }, '', path);
}
