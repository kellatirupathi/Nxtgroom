import { useEffect, useRef, useState } from 'react';
import {
  LayoutGrid,
  Users,
  X,
  History,
  UserCog,
  Settings,
  User,
  KeyRound,
  LogOut,
  ChevronUp,
} from 'lucide-react';
import type { Role } from '../types';

interface SidebarProps {
  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;
  activeTab: string;
  navigate: (tab: string) => void;
  role: Role | null;
  email: string | null;
  onLogout: () => void;
  onOpenProfile: () => void;
  onOpenChangePassword: () => void;
}

const NAV_BUTTON_BASE =
  'w-full flex items-center gap-3 px-4 py-3 rounded-md font-medium transition-colors duration-150';

function navClass(isActive: boolean) {
  return `${NAV_BUTTON_BASE} ${
    isActive
      ? 'bg-indigo-600 text-white shadow-sm'
      : 'text-slate-600 hover:bg-white hover:text-indigo-700'
  }`;
}

function roleLabel(role: Role | null) {
  if (role === 'SUPER_ADMIN') return 'Super Admin';
  if (role === 'BOA') return 'BOA';
  return 'Signed in';
}

export default function Sidebar({
  isSidebarOpen,
  setIsSidebarOpen,
  activeTab,
  navigate,
  role,
  email,
  onLogout,
  onOpenProfile,
  onOpenChangePassword,
}: SidebarProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the profile menu on outside click or Escape so it never traps focus.
  useEffect(() => {
    if (!isMenuOpen) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setIsMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen]);

  const displayEmail = email || 'Account';
  const initial = (displayEmail[0] || 'A').toUpperCase();

  const runMenuAction = (action?: () => void) => {
    setIsMenuOpen(false);
    action?.();
  };

  return (
    <aside
      className={`fixed lg:static inset-y-0 left-0 w-64 bg-sky-50 border-r border-sky-100 flex flex-col z-50 shrink-0 transform transition-transform duration-300 ease-in-out ${
        isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
      }`}
    >
      <div className="p-6 pt-8 mb-2 relative">
        <button
          type="button"
          aria-label="Close navigation menu"
          className="lg:hidden absolute top-6 right-4 text-slate-400 hover:text-slate-600 bg-white p-1 rounded-md"
          onClick={() => setIsSidebarOpen(false)}
        >
          <X size={20} />
        </button>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 flex items-center justify-center shrink-0">
            <img src="/logo.png" alt="FacultyTrack Logo" className="w-full h-full object-contain" />
          </div>
          <h2 className="font-bold text-lg leading-tight text-slate-800">FacultyTrack</h2>
        </div>
      </div>

      <nav className="flex-1 px-4 space-y-1 overflow-y-auto" aria-label="Main navigation">
        <button type="button" onClick={() => navigate('overview')} className={navClass(activeTab === 'overview')}>
          <LayoutGrid size={20} aria-hidden="true" />
          Attendance
        </button>

        <button type="button" onClick={() => navigate('daily-records')} className={navClass(activeTab === 'daily-records')}>
          <History size={20} aria-hidden="true" />
          Daily Records
        </button>

        {role === 'SUPER_ADMIN' && (
          <>
            <button
              type="button"
              onClick={() => navigate('instructor-management')}
              className={navClass(activeTab === 'instructor-management')}
            >
              <UserCog size={20} aria-hidden="true" />
              Instructors
            </button>
            <button
              type="button"
              onClick={() => navigate('boa-management')}
              className={navClass(activeTab === 'boa-management')}
            >
              <Users size={20} aria-hidden="true" />
              BOA Management
            </button>
            <button
              type="button"
              onClick={() => navigate('settings')}
              className={navClass(activeTab === 'settings')}
            >
              <Settings size={20} aria-hidden="true" />
              Settings
            </button>
          </>
        )}
      </nav>

      <div className="border-t border-sky-100 p-3 relative" ref={menuRef}>
        {isMenuOpen && (
          <div
            role="menu"
            aria-label="Account menu"
            className="absolute bottom-full left-3 right-3 mb-2 bg-white border border-slate-200 rounded-md shadow-lg overflow-hidden"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => runMenuAction(onOpenProfile)}
              className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <User size={16} aria-hidden="true" />
              Profile
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => runMenuAction(onOpenChangePassword)}
              className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100 transition-colors border-t border-slate-100"
            >
              <KeyRound size={16} aria-hidden="true" />
              Change Password
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => runMenuAction(onLogout)}
              className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium text-rose-600 hover:bg-rose-50 transition-colors border-t border-slate-100"
            >
              <LogOut size={16} aria-hidden="true" />
              Logout
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => setIsMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white transition-colors text-left"
        >
          <span
            aria-hidden="true"
            className="w-9 h-9 shrink-0 rounded-md bg-indigo-600 text-white flex items-center justify-center text-sm font-bold"
          >
            {initial}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-slate-800 truncate" title={displayEmail}>
              {displayEmail}
            </span>
            <span className="block text-xs font-medium text-slate-500">{roleLabel(role)}</span>
          </span>
          <ChevronUp
            size={16}
            aria-hidden="true"
            className={`shrink-0 text-slate-400 transition-transform duration-200 ${isMenuOpen ? '' : 'rotate-180'}`}
          />
        </button>
      </div>
    </aside>
  );
}
