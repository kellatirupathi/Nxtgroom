import { useEffect, useState } from 'react';
import { Bell, Building2, CalendarOff, ChevronLeft, ChevronRight, ClipboardList, Database, FileChartColumn, History, ScanFace, SlidersHorizontal, Users, type LucideIcon } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import CollegeManagement from './CollegeManagement';
import IdentificationSettingsSection from './IdentificationSettingsSection';
import InstructorSyncPanel from './InstructorSyncPanel';
import ReportRecipients from './ReportRecipients';
import ReportsTab from './ReportsTab';
import AccessSettingsSection from './AccessSettingsSection';
import AttendanceReminderSettings from './AttendanceReminderSettings';
import ConfigSettingsSection from './ConfigSettingsSection';
import HolidaySettings from './HolidaySettings';
import AuditLogSection from './AuditLogSection';
import FormResponsesSection from './FormResponsesSection';
import type { NotificationSettings } from '../types';
import { goToPath, pathForTab, settingsTabFromPath, settingsTabPath, TABS, type SettingsTab } from '../routes';
import { useLocation } from '../lib/useLocation';

export interface ToggleProps {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}

const SETTINGS_PATH = '/api/v2/settings/notifications';

const TOGGLES: { key: keyof NotificationSettings; label: string; description: string }[] = [
  {
    key: 'checkin_email_enabled',
    label: 'Check-in report to instructor',
    description: 'Send the appearance report once AI analysis of a check-in photo completes.',
  },
  {
    key: 'checkout_email_enabled',
    label: 'Check-out report to instructor',
    description: 'Send the appearance report after checkout photo analysis completes.',
  },
  {
    key: 'weekly_email_enabled',
    label: 'Weekly summary to instructors',
    description: 'Send each instructor their weekly attendance and appearance summary. This is off by default.',
  },
  {
    key: 'only_when_non_compliant',
    label: 'Only email when NON-COMPLIANT',
    description: 'Suppress emails for compliant results so instructors only hear about issues.',
  },
  {
    key: 'reanalyse_enabled',
    label: 'Allow re-analysing a report',
    description: 'Show a Re-analyse control on each check-in and check-out report. Re-running costs a vision call and replaces the existing report, so this is off by default.',
  },
];

const DEFAULTS: NotificationSettings = {
  checkin_email_enabled: true,
  checkout_email_enabled: true,
  weekly_email_enabled: false,
  only_when_non_compliant: false,
  reanalyse_enabled: false,
};

export function Toggle({ id, checked, disabled, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 ${
        checked ? 'bg-indigo-600' : 'bg-slate-300'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

function NotificationSettings() {
  const [settings, setSettings] = useState<NotificationSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const data = await apiFetch<NotificationSettings>(SETTINGS_PATH);
        if (!disposed) {
          setSettings({ ...DEFAULTS, ...(data || {}) });
          setError('');
        }
      } catch (requestError) {
        if (!disposed && (requestError as { status?: number })?.status !== 401) setError(requestError instanceof Error ? requestError.message : String(requestError));
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    load();
    return () => {
      disposed = true;
    };
  }, []);

  const updateSetting = async (key: keyof NotificationSettings, value: boolean) => {
    const previous = settings;
    const next = { ...settings, [key]: value };
    setSettings(next);
    setSaving(true);
    setError('');
    setStatus('');
    try {
      const saved = await apiJson<NotificationSettings>(SETTINGS_PATH, { method: 'PUT', body: next });
      setSettings({ ...DEFAULTS, ...(saved || next) });
      setStatus('Saved');
    } catch (requestError) {
      setSettings(previous);
      if ((requestError as { status?: number })?.status !== 401) setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-slate-400 font-medium">Loading notification settings…</div>;
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-5">
        <h3 className="text-base font-bold text-slate-800">Email notifications</h3>
        <p className="text-sm text-slate-500 mt-1">
          Control which appearance reports and summaries are emailed to instructors. Changes apply to future deliveries immediately.
        </p>
      </div>

      {error && (
        <div role="alert" className="mb-4 border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700 rounded-md">
          {error}
        </div>
      )}
      {status && !error && (
        <div role="status" className="mb-4 border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-700 rounded-md">
          {status}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-md divide-y divide-slate-100">
        {TOGGLES.map((toggle) => (
          <div key={toggle.key} className="flex items-start justify-between gap-3 sm:gap-6 p-4">
            <div className="min-w-0">
              <label htmlFor={toggle.key} className="block text-sm font-semibold text-slate-800">
                {toggle.label}
              </label>
              <p className="text-sm text-slate-500 mt-0.5">{toggle.description}</p>
            </div>
            <Toggle
              id={toggle.key}
              checked={Boolean(settings[toggle.key])}
              disabled={saving}
              onChange={(value) => updateSetting(toggle.key, value)}
            />
          </div>
        ))}
      </div>

      <p className="text-xs text-slate-500 mt-4">
        The non-compliant filter applies only to check-in and check-out reports. Weekly summaries are controlled by
        their own switch.
      </p>

      <AttendanceReminderSettings />

      <AccessSettingsSection />
    </div>
  );
}

const SECTIONS: ReadonlyArray<{ tab: SettingsTab; label: string; icon: LucideIcon; rootOnly?: boolean }> = [
  { tab: 'notifications', label: 'Notifications', icon: Bell },
  { tab: 'identification', label: 'Identification', icon: ScanFace },
  { tab: 'colleges', label: 'Institutes', icon: Building2 },
  { tab: 'sync', label: 'Sync Data', icon: Database },
  { tab: 'rp', label: 'RP', icon: Users },
  { tab: 'reports', label: 'Reports', icon: FileChartColumn },
  { tab: 'responses', label: 'Form Responses', icon: ClipboardList },
  { tab: 'holidays', label: 'Holidays', icon: CalendarOff },
  { tab: 'config', label: 'Config', icon: SlidersHorizontal },
  { tab: 'audit', label: 'Audit log', icon: History, rootOnly: true },
];

const MOBILE_GROUPS: ReadonlyArray<{
  title: string;
  tone: string;
  items: ReadonlyArray<{ tab: SettingsTab; label: string; detail: string }>;
}> = [
  {
    title: 'Emails',
    tone: 'bg-indigo-50 text-indigo-700',
    items: [
      { label: 'Notifications', tab: 'notifications', detail: 'Reports, reminders and who can delete' },
      { label: 'Daily reports', tab: 'reports', detail: 'Send times, recipients and past reports' },
      { label: 'Reporting partners', tab: 'rp', detail: 'Who gets alerts and escalations' },
    ],
  },
  {
    title: 'Attendance',
    tone: 'bg-cyan-50 text-cyan-700',
    items: [
      { label: 'Identification', tab: 'identification', detail: 'Face recognition or picking from a list' },
      { label: 'Holidays', tab: 'holidays', detail: 'Days with no reminders or reports' },
      { label: 'Rules and categories', tab: 'config', detail: 'Moving checked-in instructors, categories' },
    ],
  },
  {
    title: 'Data',
    tone: 'bg-slate-100 text-slate-600',
    items: [
      { label: 'Institutes', tab: 'colleges', detail: 'Add and edit campuses' },
      { label: 'Form Responses', tab: 'responses', detail: 'Daily grooming photo forms from institutes' },
      { label: 'Sync instructors', tab: 'sync', detail: 'Import the roster from BigQuery' },
      { label: 'Audit log', tab: 'audit', detail: 'Who changed what' },
    ],
  },
];

export default function SettingsPage({ role = null }: { role?: string | null }) {
  const { pathname } = useLocation();
  const atIndex = (pathname.replace(/\/+$/, '') || '/') === '/settings';
  const sections = SECTIONS.filter((section) => !section.rootOnly || role === 'SUPER_ADMIN');
  const requested = settingsTabFromPath(pathname);
  const tab = sections.some((section) => section.tab === requested) ? requested : 'notifications';
  const setTab = (next: SettingsTab) => {
    if (next !== tab) goToPath(settingsTabPath(next));
  };

  const tabClass = (value: SettingsTab) =>
    `flex shrink-0 items-center gap-2.5 whitespace-nowrap text-sm font-semibold transition-colors rounded-full border px-3.5 py-2 md:w-full md:rounded-md md:border-0 md:px-3 md:py-2.5 ${
      tab === value
        ? 'border-indigo-600 bg-indigo-600 text-white md:bg-indigo-50 md:text-indigo-700'
        : 'border-slate-200 bg-white text-slate-600 hover:text-slate-800 md:bg-transparent md:text-slate-600 md:hover:bg-slate-100'
    }`;

  return (
    <section className="w-full flex flex-col h-full" aria-labelledby="settings-title">
      <div className="-mx-1 mb-3 flex shrink-0 items-center gap-1.5 md:hidden">
        <button
          type="button"
          onClick={() => goToPath(atIndex ? pathForTab(TABS.MORE) : pathForTab(TABS.SETTINGS))}
          aria-label={atIndex ? 'Back to More' : 'Back to Settings'}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-900 hover:bg-slate-100"
        >
          <ChevronLeft size={22} aria-hidden="true" />
        </button>
        <p className="text-xl font-extrabold text-slate-900">
          {atIndex ? 'Settings' : (MOBILE_GROUPS.flatMap((group) => group.items).find((item) => item.tab === tab)?.label || 'Settings')}
        </p>
      </div>

      {atIndex && (
        <div className="flex flex-col gap-[18px] pb-4 md:hidden">
          {MOBILE_GROUPS.map((group) => {
            const items = group.items.filter((item) => sections.some((section) => section.tab === item.tab));
            if (!items.length) return null;
            return (
              <section key={group.title} aria-label={group.title}>
                <h3 className="mx-1 mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">{group.title}</h3>
                <ul className="overflow-hidden rounded-[18px] border border-slate-200 bg-white">
                  {items.map((item, index) => {
                    const Icon = SECTIONS.find((section) => section.tab === item.tab)?.icon || Bell;
                    return (
                      <li key={item.tab} className={index === 0 ? '' : 'border-t border-slate-100'}>
                        <button
                          type="button"
                          onClick={() => goToPath(settingsTabPath(item.tab))}
                          className="flex min-h-[3.75rem] w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50"
                        >
                          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${group.tone}`}>
                            <Icon size={18} aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[15px] font-semibold text-slate-900">{item.label}</span>
                            <span className="mt-px block truncate text-xs text-slate-500">{item.detail}</span>
                          </span>
                          <ChevronRight size={18} className="text-slate-400" aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <div className="mb-5 hidden shrink-0 md:block">
        <h2 id="settings-title" className="text-xl font-bold text-slate-800">Settings</h2>
        <p className="text-sm text-slate-500 mt-1">Manage notifications, identification, institutes, data sync, reporting partners, reports, form responses, holidays, configuration and the audit log.</p>
      </div>

      <div className={`min-h-0 flex-1 flex-col md:flex md:flex-row md:gap-6 ${atIndex ? 'hidden' : 'flex'}`}>
        <nav
          className="-mx-4 mb-5 hidden shrink-0 overflow-x-auto overscroll-x-contain px-4 pb-1 [scrollbar-width:none] md:mx-0 md:mb-0 md:block md:w-52 md:overflow-visible md:border-r md:border-slate-200 md:px-0 md:pb-0 md:pr-4"
          aria-label="Settings sections"
        >
          <div
            className="flex w-max gap-2 md:w-full md:flex-col md:gap-1"
            role="tablist"
            aria-orientation="vertical"
            onClick={(event) => (event.target as HTMLElement).closest('button')?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })}
          >
            {sections.map(({ tab: value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={tabClass(value)}
              >
                <Icon size={16} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        </nav>

        <div className={`min-h-0 min-w-0 flex-1 ${tab === 'responses' ? 'flex flex-col overflow-hidden max-md:overflow-auto' : 'overflow-auto'}`}>
          {tab === 'responses' && <FormResponsesSection />}
          {tab === 'notifications' && <NotificationSettings />}
          {tab === 'identification' && <IdentificationSettingsSection />}
          {tab === 'colleges' && <CollegeManagement />}
          {tab === 'sync' && <InstructorSyncPanel />}
          {tab === 'rp' && <ReportRecipients />}
          {tab === 'reports' && <ReportsTab />}
          {tab === 'holidays' && <HolidaySettings />}
          {tab === 'config' && <ConfigSettingsSection />}
          {tab === 'audit' && <AuditLogSection />}
        </div>
      </div>
    </section>
  );
}
