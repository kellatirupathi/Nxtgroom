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
  INSTRUCTOR_RECORDS: 'instructor-records',
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
  [TABS.INSTRUCTOR_RECORDS]: '/instructors/records',
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

export const SETTINGS_SECTIONS = ['notifications', 'identification', 'institutes', 'sync', 'rp', 'reports', 'config'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type SettingsTab = 'notifications' | 'identification' | 'colleges' | 'sync' | 'rp' | 'reports' | 'config';

const SETTINGS_TAB_SECTIONS: Record<SettingsTab, SettingsSection> = {
  notifications: 'notifications',
  identification: 'identification',
  colleges: 'institutes',
  sync: 'sync',
  rp: 'rp',
  reports: 'reports',
  config: 'config',
};

const SUB_ROUTES: ReadonlyArray<[RegExp, Tab]> = [
  [/^\/daily-records\/record(\/[^/]+)?$/, TABS.INSTRUCTOR_DETAIL],
  [/^\/instructors\/records$/, TABS.INSTRUCTOR_RECORDS],
  [/^\/institutes\/new$/, TABS.INSTITUTES],
  [/^\/instructors\/(new|[^/]+\/edit)$/, TABS.INSTRUCTORS],
  [/^\/users\/(new|[^/]+\/(edit|password|permissions))$/, TABS.USERS],
  [new RegExp(`^/settings/(${SETTINGS_SECTIONS.join('|')})$`), TABS.SETTINGS],
  [/^\/settings\/institutes\/(new|[^/]+\/edit)$/, TABS.SETTINGS],
];

export function tabForPath(pathname: string): Tab {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized === '/' || normalized === '') return TABS.OVERVIEW;
  for (const [pattern, tab] of SUB_ROUTES) {
    if (pattern.test(normalized)) return tab;
  }
  return PATH_TO_TAB.get(normalized) ?? TABS.OVERVIEW;
}

export const LOCATION_CHANGE_EVENT = 'facultytrack:locationchange';

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function announceLocationChange(): void {
  window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));
}

export function goToPath(path: string, { replace = false, state = null }: { replace?: boolean; state?: unknown } = {}): void {
  if (typeof window === 'undefined') return;
  if (currentUrl() === path) return;
  window.history[replace ? 'replaceState' : 'pushState'](state, '', path);
  announceLocationChange();
}

export function openChildPath(path: string): void {
  goToPath(path, { state: { child: true } });
}

export function closeChildPath(fallback: string): void {
  if (typeof window === 'undefined') return;
  if ((window.history.state as { child?: boolean } | null)?.child) {
    window.history.back();
    return;
  }
  goToPath(fallback, { replace: true });
}

export function readQueryParam(name: string): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(name) ?? '';
}

export function currentPathWith(updates: Record<string, string | null | undefined>): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  for (const [name, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === '') params.delete(name);
    else params.set(name, value);
  }
  const search = params.toString();
  return `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;
}

export function writeQueryParams(updates: Record<string, string | null | undefined>): void {
  if (typeof window === 'undefined') return;
  const next = currentPathWith(updates);
  if (next === currentUrl()) return;
  window.history.replaceState(window.history.state, '', next);
}

export function pathWithQuery(path: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(name, value);
  }
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

export function settingsSectionFromPath(pathname: string): SettingsSection {
  const match = pathname.replace(/\/+$/, '').match(/^\/settings\/([a-z]+)/);
  const section = match?.[1] as SettingsSection | undefined;
  return section && SETTINGS_SECTIONS.includes(section) ? section : 'notifications';
}

export function settingsTabFromPath(pathname: string): SettingsTab {
  const section = settingsSectionFromPath(pathname);
  return section === 'institutes' ? 'colleges' : section;
}

export function settingsTabPath(tab: SettingsTab): string {
  return `/settings/${SETTINGS_TAB_SECTIONS[tab]}`;
}

export type DialogRoute = { view: 'list' } | { view: 'new' } | { view: 'edit' | 'password' | 'permissions'; id: string };

export function dialogRouteFromPath(pathname: string, base: string): DialogRoute {
  const normalized = pathname.replace(/\/+$/, '');
  if (normalized === `${base}/new`) return { view: 'new' };
  const prefix = `${base}/`;
  if (normalized.startsWith(prefix)) {
    const match = normalized.slice(prefix.length).match(/^([^/]+)\/(edit|password|permissions)$/);
    if (match) return { view: match[2] as 'edit' | 'password' | 'permissions', id: decodeURIComponent(match[1]) };
  }
  return { view: 'list' };
}

export function dialogPath(base: string, route: DialogRoute): string {
  if (route.view === 'list') return base;
  if (route.view === 'new') return `${base}/new`;
  return `${base}/${encodeURIComponent(route.id)}/${route.view}`;
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
  announceLocationChange();
}

export function replaceTabPath(tab: string, recordId?: string): void {
  if (typeof window === 'undefined') return;
  const path = pathForTab(tab, recordId);
  if (window.location.pathname === path) return;
  if (!recordId && tab !== TABS.INSTRUCTOR_DETAIL && tabForPath(window.location.pathname) === tab) return;
  window.history.replaceState({ tab }, '', path);
  announceLocationChange();
}
