import { useEffect, useRef, useState } from 'react';
import {
  ChartColumnBig,
  LayoutDashboard,
  LayoutGrid,
  History,
  UserCog,
  UserRoundSearch,
  Users,
  Settings,
  User,
  KeyRound,
  LogOut,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { isElevatedRole, type Role } from '../types.ts';

interface NavItem {
  tab: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  /**
   * Gated on the identify permission instead of on role. A BOA granted it is
   * usually the only person who can recognise a face from their own campus, so
   * role alone would hide the queue from exactly the right people.
   */
  identifyOnly?: boolean;
}

/**
 * Primary destinations shown in the bar. Anything beyond these lives in the
 * "More" sheet so the bar never scrolls or crowds on small screens.
 */
const PRIMARY_ITEMS: NavItem[] = [
  { tab: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, adminOnly: true },
  { tab: 'overview', label: 'Attendance', icon: LayoutGrid },
  { tab: 'daily-records', label: 'Records', icon: History },
  { tab: 'instructor-management', label: 'Instructors', icon: UserCog, adminOnly: true },
];

const OVERFLOW_ITEMS: NavItem[] = [
  { tab: 'institutes', label: 'Institutes', icon: ChartColumnBig, adminOnly: true },
  // Gated on the identify permission rather than on role, so a BOA who has been
  // granted it still reaches the queue.
  { tab: 'unidentified', label: 'Unidentified', icon: UserRoundSearch, identifyOnly: true },
  { tab: 'boa-management', label: 'Users', icon: Users, adminOnly: true },
  { tab: 'settings', label: 'Settings', icon: Settings, adminOnly: true },
];

interface BottomNavProps {
  activeTab: string;
  navigate: (tab: string) => void;
  role: Role | null;
  email: string | null;
  /** Whether to offer the unidentified queue; see Sidebar for why it is its own flag. */
  canIdentify?: boolean;
  onLogout: () => void;
  onOpenProfile: () => void;
  onOpenChangePassword: () => void;
}

function roleLabel(role: Role | null): string {
  if (role === 'SUPER_ADMIN') return 'Super Admin';
  if (role === 'ADMIN') return 'Admin';
  if (role === 'BOA') return 'BOA';
  return 'Signed in';
}

export default function BottomNav({
  activeTab,
  navigate,
  role,
  email,
  canIdentify = false,
  onLogout,
  onOpenProfile,
  onOpenChangePassword,
}: BottomNavProps) {
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  const visible = (items: NavItem[]) =>
    items.filter((item) => {
      if (item.adminOnly && !isElevatedRole(role)) return false;
      // Administrators reach the queue from Settings; a BOA with the
      // permission cannot open Settings, so it stays in their menu.
      if (item.identifyOnly && (!canIdentify || isElevatedRole(role))) return false;
      return true;
    });

  const primary = visible(PRIMARY_ITEMS);
  const overflow = visible(OVERFLOW_ITEMS);

  // Escape closes the sheet, matching the sidebar's account menu behaviour.
  useEffect(() => {
    if (!isSheetOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSheetOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isSheetOpen]);

  const go = (tab: string) => {
    setIsSheetOpen(false);
    navigate(tab);
  };

  const runAction = (action: () => void) => {
    setIsSheetOpen(false);
    action();
  };

  const overflowActive = overflow.some((item) => item.tab === activeTab);
  const displayEmail = email || 'Account';
  const initial = (displayEmail[0] || 'A').toUpperCase();

  const itemClass = (isActive: boolean) =>
    `group flex min-w-0 flex-1 flex-col items-center justify-center gap-1 py-1.5 min-h-[var(--bottom-nav-height)] transition-colors focus:outline-none ${
      isActive ? 'text-indigo-700' : 'text-slate-500 active:text-slate-800'
    }`;

  // The pill behind the active icon: how an Android app marks where you are.
  // Sized from the screen width, as the bar itself is.
  const indicatorClass = (isActive: boolean) =>
    `flex h-8 w-[clamp(3.5rem,2.75rem+3vw,4.75rem)] items-center justify-center rounded-full transition-colors group-focus-visible:ring-2 group-focus-visible:ring-indigo-500 ${
      isActive ? 'bg-indigo-100' : ''
    }`;

  const labelClass = (isActive: boolean) =>
    `max-w-full truncate px-1 text-[length:var(--bottom-nav-label)] leading-none ${isActive ? 'font-bold' : 'font-semibold'}`;

  return (
    <>
      {isSheetOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            // Stops at the bar, like the sheet: the bar stays lit and tappable
            // while the sheet is open, and Profile closes it again.
            className="fixed inset-x-0 top-0 bottom-[calc(var(--bottom-nav-height)+var(--inset-bottom)+1px)] bg-slate-900/40 z-[45] lg:hidden"
            onClick={() => setIsSheetOpen(false)}
          />
          <div
            ref={sheetRef}
            role="menu"
            aria-label="More navigation options"
            /* Rests on the bar's top edge - the bar's height, its 1px border
               and the gesture-bar inset below it - so it rises out of the bar
               instead of covering it. */
            className="fixed inset-x-0 bottom-[calc(var(--bottom-nav-height)+var(--inset-bottom)+1px)] z-[46] lg:hidden bg-white border-t border-slate-200 rounded-t-2xl pb-1 shadow-[0_-4px_24px_rgba(0,0,0,0.08)]"
          >
            <div aria-hidden="true" className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-slate-300" />
            <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100">
              <span
                aria-hidden="true"
                className="w-10 h-10 shrink-0 rounded-md bg-indigo-600 text-white flex items-center justify-center text-sm font-bold"
              >
                {initial}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-800 truncate">{displayEmail}</span>
                <span className="block text-xs font-medium text-slate-500">{roleLabel(role)}</span>
              </span>
            </div>

            {overflow.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.tab}
                  type="button"
                  role="menuitem"
                  onClick={() => go(item.tab)}
                  className={`w-full flex items-center gap-3 px-5 py-4 text-[15px] font-medium border-b border-slate-100 transition-colors ${
                    activeTab === item.tab ? 'text-indigo-700 bg-indigo-50' : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Icon size={20} aria-hidden="true" />
                  {item.label}
                </button>
              );
            })}

            <button
              type="button"
              role="menuitem"
              onClick={() => runAction(onOpenProfile)}
              className="w-full flex items-center gap-3 px-5 py-4 text-[15px] font-medium text-slate-700 hover:bg-slate-50 border-b border-slate-100 transition-colors"
            >
              <User size={20} aria-hidden="true" />
              Profile
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => runAction(onOpenChangePassword)}
              className="w-full flex items-center gap-3 px-5 py-4 text-[15px] font-medium text-slate-700 hover:bg-slate-50 border-b border-slate-100 transition-colors"
            >
              <KeyRound size={20} aria-hidden="true" />
              Change Password
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => runAction(onLogout)}
              className="w-full flex items-center gap-3 px-5 py-4 text-[15px] font-medium text-rose-600 hover:bg-rose-50 transition-colors"
            >
              <LogOut size={20} aria-hidden="true" />
              Logout
            </button>
          </div>
        </>
      )}

      <nav
        aria-label="Primary"
        className="shrink-0 lg:hidden bg-white border-t border-slate-200 pb-[var(--inset-bottom)] shadow-[0_-4px_16px_rgba(15,23,42,0.08)]"
      >
        {/* Evenly spread, and centred on a tablet rather than stretched to
            its edges. */}
        <div className="mx-auto flex w-full max-w-2xl items-stretch px-1">
          {primary.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.tab;
            return (
              <button
                key={item.tab}
                type="button"
                onClick={() => go(item.tab)}
                aria-current={isActive ? 'page' : undefined}
                className={itemClass(isActive)}
              >
                <span className={indicatorClass(isActive)}>
                  <Icon aria-hidden="true" strokeWidth={isActive ? 2.4 : 2} className="size-[var(--bottom-nav-icon)]" />
                </span>
                <span className={labelClass(isActive)}>{item.label}</span>
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => setIsSheetOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={isSheetOpen}
            aria-label="Open account and more options"
            className={itemClass(isSheetOpen || overflowActive)}
          >
            <span className={indicatorClass(isSheetOpen || overflowActive)}>
              <span
                aria-hidden="true"
                className={`flex size-[calc(var(--bottom-nav-icon)+2px)] items-center justify-center rounded-full text-[13px] font-bold ${
                  isSheetOpen || overflowActive ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-700'
                }`}
              >
                {initial}
              </span>
            </span>
            <span className={labelClass(isSheetOpen || overflowActive)}>Profile</span>
          </button>
        </div>
      </nav>
    </>
  );
}
