import { Camera, Ellipsis, History, House, UserCog } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { isElevatedRole, type Role } from '../types.ts';

interface NavItem {
  tab: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

const LEFT_ITEMS: NavItem[] = [
  { tab: 'dashboard', label: 'Home', icon: House, adminOnly: true },
  { tab: 'daily-records', label: 'Records', icon: History },
];

const RIGHT_ITEMS: NavItem[] = [
  { tab: 'instructor-management', label: 'Instructors', icon: UserCog, adminOnly: true },
  { tab: 'more', label: 'More', icon: Ellipsis },
];

const RECORDS_TABS = new Set(['daily-records', 'instructor-detail']);
const INSTRUCTOR_TABS = new Set(['instructor-management', 'instructor-records']);
const MORE_TABS = new Set(['more', 'institutes', 'boa-management', 'form-responses', 'settings']);

interface BottomNavProps {
  activeTab: string;
  navigate: (tab: string) => void;
  role: Role | null;
}

function ownsTab(item: NavItem, activeTab: string): boolean {
  if (item.tab === 'daily-records') return RECORDS_TABS.has(activeTab);
  if (item.tab === 'instructor-management') return INSTRUCTOR_TABS.has(activeTab);
  if (item.tab === 'more') return MORE_TABS.has(activeTab);
  return item.tab === activeTab;
}

export default function BottomNav({ activeTab, navigate, role }: BottomNavProps) {
  const visible = (items: NavItem[]) => items.filter((item) => !item.adminOnly || isElevatedRole(role));

  const itemClass = (isActive: boolean) =>
    `group flex min-w-0 flex-1 flex-col items-center justify-end gap-1 pt-1.5 pb-2 min-h-[var(--bottom-nav-height)] transition-colors focus:outline-none ${
      isActive ? 'text-indigo-700' : 'text-slate-500 active:text-slate-800'
    }`;

  const indicatorClass = (isActive: boolean) =>
    `flex h-8 w-14 items-center justify-center rounded-full transition-colors group-focus-visible:ring-2 group-focus-visible:ring-indigo-500 ${
      isActive ? 'bg-indigo-100' : ''
    }`;

  const labelClass = (isActive: boolean) =>
    `max-w-full truncate px-1 text-[length:var(--bottom-nav-label)] leading-none ${isActive ? 'font-bold' : 'font-semibold'}`;

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const isActive = ownsTab(item, activeTab);
    return (
      <button
        key={item.tab}
        type="button"
        onClick={() => navigate(item.tab)}
        aria-current={isActive ? 'page' : undefined}
        className={itemClass(isActive)}
      >
        <span className={indicatorClass(isActive)}>
          <Icon aria-hidden="true" strokeWidth={isActive ? 2.4 : 2} className="size-[var(--bottom-nav-icon)]" />
        </span>
        <span className={labelClass(isActive)}>{item.label}</span>
      </button>
    );
  };

  const attendanceActive = activeTab === 'overview';

  return (
    <nav
      aria-label="Primary"
      className="shrink-0 lg:hidden bg-white border-t border-slate-200 pb-[var(--inset-bottom)] shadow-[0_-4px_16px_rgba(15,23,42,0.06)]"
    >
      <div className="mx-auto flex w-full max-w-2xl items-end px-1.5">
        {visible(LEFT_ITEMS).map(renderItem)}
        <button
          type="button"
          onClick={() => navigate('overview')}
          aria-current={attendanceActive ? 'page' : undefined}
          className={`group flex min-w-0 flex-1 flex-col items-center justify-end gap-1 pb-2 min-h-[var(--bottom-nav-height)] focus:outline-none ${
            attendanceActive ? 'text-indigo-700' : 'text-indigo-600'
          }`}
        >
          <span
            className={`-mt-6 flex h-14 w-14 items-center justify-center rounded-full border-4 border-[#f8f9fc] bg-indigo-600 text-white shadow-[0_8px_18px_-6px_rgba(79,70,229,0.6)] transition-transform group-active:scale-95 group-focus-visible:ring-2 group-focus-visible:ring-indigo-500 group-focus-visible:ring-offset-2 ${
              attendanceActive ? 'bg-indigo-700' : ''
            }`}
          >
            <Camera aria-hidden="true" strokeWidth={2.2} className="size-6" />
          </span>
          <span className={labelClass(attendanceActive)}>Attendance</span>
        </button>
        {visible(RIGHT_ITEMS).map(renderItem)}
      </div>
    </nav>
  );
}
