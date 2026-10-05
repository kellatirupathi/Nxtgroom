import { useEffect, useState } from 'react';
import { AlarmClock, Save } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import { Toggle } from './SettingsPage';
import { useToast } from './useToast';
import { sendTimeLabel, toTwelveHour, toTwentyFourHour, type Period } from '../lib/dailyReportTimes';

const PATH = '/api/v2/settings/attendance-reminders';
const HOURS = Array.from({ length: 12 }, (_, index) => index + 1);
const MINUTES = Array.from({ length: 60 }, (_, index) => index);
const SELECT = 'h-10 rounded-md border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60';

type Kind = 'checkin' | 'checkout';

interface ReminderSettings {
  checkin_reminder_enabled: boolean;
  checkin_reminder_time: string;
  checkout_reminder_enabled: boolean;
  checkout_reminder_time: string;
}

const EMPTY: ReminderSettings = {
  checkin_reminder_enabled: false,
  checkin_reminder_time: '',
  checkout_reminder_enabled: false,
  checkout_reminder_time: '',
};

const SUGGESTED: Record<Kind, string> = { checkin: '10:30', checkout: '19:00' };

const ROWS: ReadonlyArray<{ kind: Kind; label: string; description: string }> = [
  {
    kind: 'checkin',
    label: 'Check-in missed email',
    description: 'Emails each instructor who has not checked in by this time, Monday to Saturday. Choose a time in the morning half.',
  },
  {
    kind: 'checkout',
    label: 'Check-out missed email',
    description: 'Emails each instructor who checked in today but has not checked out by this time.',
  },
];

interface ReminderRowProps {
  kind: Kind;
  label: string;
  description: string;
  enabled: boolean;
  savedTime: string;
  disabled: boolean;
  onSave: (kind: Kind, change: Partial<ReminderSettings>) => Promise<boolean>;
}

function ReminderRow({ kind, label, description, enabled, savedTime, disabled, onSave }: ReminderRowProps) {
  const [draft, setDraft] = useState(savedTime || SUGGESTED[kind]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(savedTime || SUGGESTED[kind]);
  }, [savedTime, kind]);

  const time = toTwelveHour(draft);
  const dirty = draft !== savedTime;
  const change = (part: Partial<{ hour: number; minute: number; period: Period }>) => setDraft(toTwentyFourHour({ ...time, ...part }));

  const save = async (next: Partial<ReminderSettings>) => {
    setSaving(true);
    await onSave(kind, next);
    setSaving(false);
  };

  const toggle = (value: boolean) => void save(value
    ? { [`${kind}_reminder_enabled`]: true, [`${kind}_reminder_time`]: draft }
    : { [`${kind}_reminder_enabled`]: false });

  const status = enabled && savedTime
    ? `On · sent every day at ${sendTimeLabel(savedTime)} (India time)${kind === 'checkin' ? ', Monday to Saturday' : ''}.`
    : 'Off. No emails are sent.';

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3 sm:gap-6">
        <div className="min-w-0">
          <label htmlFor={`${kind}_reminder_enabled`} className="block text-sm font-semibold text-slate-800">{label}</label>
          <p className="mt-0.5 text-sm text-slate-500">{description}</p>
        </div>
        <Toggle id={`${kind}_reminder_enabled`} checked={enabled} disabled={disabled || saving} onChange={toggle} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Send at</span>
        <select aria-label={`${label}: hour`} value={time.hour} onChange={(event) => change({ hour: Number(event.target.value) })} disabled={disabled || saving} className={SELECT}>
          {HOURS.map((hour) => <option key={hour} value={hour}>{hour}</option>)}
        </select>
        <span className="font-bold text-slate-400" aria-hidden="true">:</span>
        <select aria-label={`${label}: minute`} value={time.minute} onChange={(event) => change({ minute: Number(event.target.value) })} disabled={disabled || saving} className={SELECT}>
          {MINUTES.map((minute) => <option key={minute} value={minute}>{String(minute).padStart(2, '0')}</option>)}
        </select>
        <select aria-label={`${label}: AM or PM`} value={time.period} onChange={(event) => change({ period: event.target.value as Period })} disabled={disabled || saving} className={SELECT}>
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </select>
        <button
          type="button"
          onClick={() => void save({ [`${kind}_reminder_time`]: draft })}
          disabled={disabled || saving || !dirty}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-indigo-600 px-3 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
        >
          <Save size={15} aria-hidden="true" />
          {saving ? 'Saving…' : 'Save time'}
        </button>
        {dirty && savedTime && <span className="text-xs font-medium text-amber-600">Unsaved change</span>}
      </div>
      <p className={`mt-2 text-xs ${enabled ? 'font-medium text-emerald-700' : 'text-slate-400'}`}>{status}</p>
    </div>
  );
}

export default function AttendanceReminderSettings() {
  const [settings, setSettings] = useState<ReminderSettings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const toast = useToast();

  useEffect(() => {
    let disposed = false;
    apiFetch<ReminderSettings>(PATH)
      .then((data) => { if (!disposed && data) setSettings({ ...EMPTY, ...data }); })
      .catch((requestError) => {
        if (!disposed && (requestError as { status?: number })?.status !== 401) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, []);

  const save = async (kind: Kind, change: Partial<ReminderSettings>): Promise<boolean> => {
    try {
      const saved = await apiJson<ReminderSettings>(PATH, { method: 'PUT', body: change });
      setSettings({ ...EMPTY, ...saved });
      const label = kind === 'checkin' ? 'Check-in missed email' : 'Check-out missed email';
      const time = saved[`${kind}_reminder_time`];
      toast.success(saved[`${kind}_reminder_enabled`] ? `${label} is on` : `${label} is off`, {
        detail: saved[`${kind}_reminder_enabled`] && time
          ? `Sent every day at ${sendTimeLabel(time)}. A time already past today starts from tomorrow.`
          : time ? `Saved for ${sendTimeLabel(time)}; turn it on to send.` : undefined,
      });
      return true;
    } catch (requestError) {
      toast.error('Could not save the setting', {
        detail: requestError instanceof Error ? requestError.message : String(requestError),
      });
      return false;
    }
  };

  return (
    <section className="mt-8" aria-labelledby="attendance-reminders-title">
      <h3 id="attendance-reminders-title" className="flex items-center gap-2 text-base font-bold text-slate-800">
        <AlarmClock size={18} className="text-indigo-600" aria-hidden="true" />
        Missed check-in and check-out emails
      </h3>
      <p className="mt-1 mb-4 text-sm text-slate-500">
        Reminder emails to instructors, sent once a day at the time set in each row. Both are off until turned on.
        A time already past today starts from tomorrow.
      </p>
      {error && (
        <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>
      )}
      <div className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
        {ROWS.map((row) => (
          <ReminderRow
            key={row.kind}
            kind={row.kind}
            label={row.label}
            description={row.description}
            enabled={settings[`${row.kind}_reminder_enabled`]}
            savedTime={settings[`${row.kind}_reminder_time`]}
            disabled={loading || Boolean(error)}
            onSave={save}
          />
        ))}
      </div>
    </section>
  );
}
