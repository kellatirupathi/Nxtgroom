import { ChartColumnBig, ChevronRight, KeyRound, LogOut, Settings, ShieldAlert, User, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { isElevatedRole, type Role } from '../types';

interface MorePageProps {
  role: Role | null;
  email: string | null;
  navigate: (tab: string) => void;
  onOpenProfile: () => void;
  onOpenChangePassword: () => void;
  onLogout: () => void;
}

interface MenuRow {
  key: string;
  label: string;
  icon: LucideIcon;
  tone: string;
  onSelect: () => void;
}

function roleLabel(role: Role | null): string {
  if (role === 'SUPER_ADMIN') return 'Super Admin';
  if (role === 'ADMIN') return 'Admin';
  if (role === 'BOA') return 'BOA';
  return 'Signed in';
}

const ROLE_TAG: Record<Role, string> = {
  SUPER_ADMIN: 'bg-violet-50 text-violet-700 border-violet-200',
  ADMIN: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  BOA: 'bg-slate-100 text-slate-600 border-slate-200',
};

function MenuGroup({ title, rows }: { title: string; rows: MenuRow[] }) {
  return (
    <section aria-label={title}>
      <h2 className="mx-1 mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">{title}</h2>
      <ul className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {rows.map((row, index) => {
          const Icon = row.icon;
          return (
            <li key={row.key} className={index === 0 ? '' : 'border-t border-slate-100'}>
              <button
                type="button"
                onClick={row.onSelect}
                className="flex min-h-[3.75rem] w-full items-center gap-3 px-3.5 py-3 text-left text-[15px] font-semibold text-slate-800 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50"
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${row.tone}`}>
                  <Icon size={18} aria-hidden="true" />
                </span>
                <span className="flex-1">{row.label}</span>
                <ChevronRight size={18} className="text-slate-400" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function MorePage({ role, email, navigate, onOpenProfile, onOpenChangePassword, onLogout }: MorePageProps) {
  const displayEmail = email || 'Account';
  const initial = (displayEmail[0] || 'A').toUpperCase();
  const elevated = isElevatedRole(role);

  const manage: MenuRow[] = [
    { key: 'escalations', label: 'Escalations', icon: ShieldAlert, tone: 'bg-rose-50 text-rose-700', onSelect: () => navigate('escalations') },
    { key: 'institutes', label: 'Institutes', icon: ChartColumnBig, tone: 'bg-indigo-50 text-indigo-700', onSelect: () => navigate('institutes') },
    { key: 'users', label: 'Users', icon: Users, tone: 'bg-indigo-50 text-indigo-700', onSelect: () => navigate('boa-management') },
    { key: 'settings', label: 'Settings', icon: Settings, tone: 'bg-indigo-50 text-indigo-700', onSelect: () => navigate('settings') },
  ];

  const account: MenuRow[] = [
    { key: 'password', label: 'Change password', icon: KeyRound, tone: 'bg-slate-100 text-slate-600', onSelect: onOpenChangePassword },
  ];

  return (
    <section className="mx-auto flex w-full max-w-xl flex-col gap-4" aria-labelledby="more-title">
      <h1 id="more-title" className="text-[22px] font-extrabold text-slate-900">More</h1>

      <button
        type="button"
        onClick={onOpenProfile}
        className="flex w-full items-center gap-3.5 rounded-2xl border border-slate-200 bg-white p-3.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <span aria-hidden="true" className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xl font-bold text-white">
          {initial}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-bold text-slate-900">{displayEmail}</span>
          {role && (
            <span className={`mt-1.5 inline-flex rounded-md border px-2 py-0.5 text-[11px] font-bold ${ROLE_TAG[role]}`}>
              {roleLabel(role)}
            </span>
          )}
        </span>
        <span className="sr-only">Open profile</span>
        <User size={18} className="text-slate-400" aria-hidden="true" />
      </button>

      {elevated && <MenuGroup title="Manage" rows={manage} />}

      <section aria-label="Account">
        <h2 className="mx-1 mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Account</h2>
        <ul className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {account.map((row) => {
            const Icon = row.icon;
            return (
              <li key={row.key}>
                <button
                  type="button"
                  onClick={row.onSelect}
                  className="flex min-h-[3.75rem] w-full items-center gap-3 px-3.5 py-3 text-left text-[15px] font-semibold text-slate-800 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50"
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${row.tone}`}>
                    <Icon size={18} aria-hidden="true" />
                  </span>
                  <span className="flex-1">{row.label}</span>
                  <ChevronRight size={18} className="text-slate-400" aria-hidden="true" />
                </button>
              </li>
            );
          })}
          <li className="border-t border-slate-100">
            <button
              type="button"
              onClick={onLogout}
              className="flex min-h-[3.75rem] w-full items-center gap-3 px-3.5 py-3 text-left text-[15px] font-semibold text-rose-700 transition-colors hover:bg-rose-50 focus:outline-none focus-visible:bg-rose-50"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-rose-50 text-rose-700">
                <LogOut size={18} aria-hidden="true" />
              </span>
              Sign out
            </button>
          </li>
        </ul>
      </section>

      <p className="pt-2 text-center text-xs text-slate-500">FacultyTrack</p>
    </section>
  );
}
