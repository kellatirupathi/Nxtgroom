import { useEffect, useState } from 'react';
import { Bell, Building2, CalendarOff, Database, FileChartColumn, History, ScanFace, SlidersHorizontal, Users, type LucideIcon } from 'lucide-react';
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
import type { NotificationSettings } from '../types';
import { goToPath, settingsTabFromPath, settingsTabPath, type SettingsTab } from '../routes';
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
  { tab: 'holidays', label: 'Holidays', icon: CalendarOff },
  { tab: 'config', label: 'Config', icon: SlidersHorizontal },
  { tab: 'audit', label: 'Audit log', icon: History, rootOnly: true },
];

export default function SettingsPage({ role = null }: { role?: string | null }) {
  const { pathname } = useLocation();
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
      <div className="mb-5 shrink-0">
        <h2 id="settings-title" className="text-xl font-bold text-slate-800">Settings</h2>
        <p className="text-sm text-slate-500 mt-1">Manage notifications, identification, institutes, data sync, reporting partners, reports, holidays, configuration and the audit log.</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row md:gap-6">
        <nav
          className="-mx-4 mb-5 shrink-0 overflow-x-auto overscroll-x-contain px-4 pb-1 [scrollbar-width:none] md:mx-0 md:mb-0 md:w-52 md:overflow-visible md:border-r md:border-slate-200 md:px-0 md:pb-0 md:pr-4"
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

        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
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
