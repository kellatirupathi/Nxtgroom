import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CalendarClock, Mail, Plus, Save, Trash2, X } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './useToast';
import { Toggle } from './SettingsPage';
import {
  repeatedSendTime,
  sendTimeLabel,
  sortedSendTimes,
  suggestedSendTime,
  toTwelveHour,
  toTwentyFourHour,
  type Period,
} from '../lib/dailyReportTimes';

const PATH = '/api/v2/settings/daily-report';
const RECIPIENTS_PATH = `${PATH}/recipients`;
const MAX_TIMES = 8;
const HOURS = Array.from({ length: 12 }, (_, index) => index + 1);
const MINUTES = Array.from({ length: 60 }, (_, index) => index);

interface DailyReportData {
  enabled: boolean;
  times: string[];
  emails: string[];
}

interface TimeRow {
  key: number;
  value: string;
}

const SELECT = 'h-10 rounded-md border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60';

function listLabel(times: string[]): string {
  const labels = times.map(sendTimeLabel);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * The daily report: a switch, the times it is sent, and who receives it.
 *
 * Its recipients are a separate list from the reporting partners above, who
 * already receive every individual report. The switch and the recipients save
 * as soon as they change; the times are edited as a set and saved together,
 * so a half-finished edit never becomes the live schedule.
 */
export default function DailyReportSettings() {
  const [data, setData] = useState<DailyReportData>({ enabled: false, times: [], emails: [] });
  const [rows, setRows] = useState<TimeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingSwitch, setSavingSwitch] = useState(false);
  const [savingTimes, setSavingTimes] = useState(false);
  const [email, setEmail] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [error, setError] = useState('');
  const nextKey = useRef(0);
  const toast = useToast();

  const rowsFor = (times: string[]) => times.map((value) => ({ key: nextKey.current++, value }));

  useEffect(() => {
    let disposed = false;
    apiFetch<DailyReportData>(PATH)
      .then((response) => {
        if (disposed || !response) return;
        setData(response);
        setRows(response.times.map((value) => ({ key: nextKey.current++, value })));
      })
      .catch((requestError) => {
        if (!disposed && (requestError as { status?: number })?.status !== 401) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, []);

  const values = rows.map((row) => row.value);
  const repeated = repeatedSendTime(values);
  const dirty = sortedSendTimes(values).join(',') !== sortedSendTimes(data.times).join(',');

  const setEnabled = async (enabled: boolean) => {
    const previous = data;
    setData({ ...data, enabled });
    setSavingSwitch(true);
    try {
      const saved = await apiJson<DailyReportData>(PATH, { method: 'PUT', body: { enabled } });
      setData((current) => ({ ...current, enabled: saved.enabled, times: saved.times }));
      toast.success(enabled ? 'Daily reports turned on' : 'Daily reports turned off');
    } catch (requestError) {
      setData(previous);
      toast.error('Could not save the setting', {
        detail: requestError instanceof Error ? requestError.message : String(requestError),
      });
    } finally {
      setSavingSwitch(false);
    }
  };

  const updateRow = (key: number, change: Partial<{ hour: number; minute: number; period: Period }>) => {
    setRows((current) => current.map((row) => (
      row.key === key ? { ...row, value: toTwentyFourHour({ ...toTwelveHour(row.value), ...change }) } : row
    )));
  };

  const addRow = () => {
    setRows((current) => [...current, { key: nextKey.current++, value: suggestedSendTime(current.map((row) => row.value)) }]);
  };

  const removeRow = (key: number) => setRows((current) => current.filter((row) => row.key !== key));

  const saveTimes = async () => {
    if (repeated) return;
    setSavingTimes(true);
    try {
      const saved = await apiJson<DailyReportData>(PATH, { method: 'PUT', body: { times: values } });
      setData((current) => ({ ...current, enabled: saved.enabled, times: saved.times }));
      setRows(rowsFor(saved.times));
      toast.success('Send times saved', {
        detail: saved.times.length ? `Daily reports go out at ${listLabel(saved.times)}.` : 'No send times are set.',
      });
    } catch (requestError) {
      toast.error('Could not save the send times', {
        detail: requestError instanceof Error ? requestError.message : String(requestError),
      });
    } finally {
      setSavingTimes(false);
    }
  };

  const addRecipient = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!value) return;
    setAdding(true);
    setError('');
    try {
      const response = await apiJson<{ emails: string[] }>(RECIPIENTS_PATH, { method: 'POST', body: { email: value } });
      setData((current) => ({ ...current, emails: Array.isArray(response?.emails) ? response.emails : [] }));
      setEmail('');
      toast.success('Daily report recipient added', { detail: value });
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error('Could not add recipient', { detail: message });
    } finally {
      setAdding(false);
    }
  };

  const removeRecipient = async (value: string) => {
    setRemoving(value);
    setError('');
    try {
      const response = await apiFetch<{ emails: string[] }>(`${RECIPIENTS_PATH}/${encodeURIComponent(value)}`, { method: 'DELETE' });
      setData((current) => ({ ...current, emails: Array.isArray(response?.emails) ? response.emails : [] }));
      toast.success('Daily report recipient removed', { detail: value });
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error('Could not remove recipient', { detail: message });
    } finally {
      setRemoving(null);
      setConfirmTarget(null);
    }
  };

  const incomplete = data.enabled && (!data.times.length || !data.emails.length);

  return (
    <section className="mt-10 border-t border-slate-200 pt-8" aria-labelledby="daily-report-title">
      <div className="mb-5">
        <h3 id="daily-report-title" className="text-lg font-extrabold text-slate-800 flex items-center gap-2">
          <CalendarClock size={20} className="text-indigo-600" aria-hidden="true" />
          Daily report
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          One email at each time you choose, listing everyone who checked in or out since the previous
          one - the first covers from midnight - with their check-in and check-out times, improvement
          points and a link to each report.
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Sent only to the addresses in this section, not to the reporting partners on the RP tab.
        </p>
      </div>

      <div className="mb-5 rounded-md border border-slate-200 bg-white divide-y divide-slate-100">
        <div className="flex items-start justify-between gap-6 p-4">
          <div className="min-w-0">
            <label htmlFor="daily_report_enabled" className="block text-sm font-semibold text-slate-800">Send daily reports</label>
            <p className="mt-0.5 text-sm text-slate-500">
              {data.enabled && data.times.length
                ? `Sent at ${listLabel(data.times)} (India time).`
                : 'Sent at the times below (India time).'}
            </p>
          </div>
          <Toggle
            id="daily_report_enabled"
            checked={data.enabled}
            disabled={loading || savingSwitch}
            onChange={(value: boolean) => void setEnabled(value)}
          />
        </div>

        <div className="p-4">
          <p className="text-sm font-semibold text-slate-800">Send times</p>
          <p className="mt-0.5 mb-3 text-sm text-slate-500">
            For example 1:00 PM for the morning's check-ins and 6:30 PM for the afternoon.
          </p>

          {rows.length === 0 ? (
            <p className="mb-3 text-sm text-slate-400">{loading ? 'Loading…' : 'No send times yet.'}</p>
          ) : (
            <ul className="mb-3 flex flex-col gap-2">
              {rows.map((row, index) => {
                const time = toTwelveHour(row.value);
                return (
                  <li key={row.key} className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={`Send time ${index + 1}: hour`}
                      value={time.hour}
                      onChange={(event) => updateRow(row.key, { hour: Number(event.target.value) })}
                      disabled={savingTimes}
                      className={SELECT}
                    >
                      {HOURS.map((hour) => <option key={hour} value={hour}>{hour}</option>)}
                    </select>
                    <span className="font-bold text-slate-400" aria-hidden="true">:</span>
                    <select
                      aria-label={`Send time ${index + 1}: minute`}
                      value={time.minute}
                      onChange={(event) => updateRow(row.key, { minute: Number(event.target.value) })}
                      disabled={savingTimes}
                      className={SELECT}
                    >
                      {MINUTES.map((minute) => <option key={minute} value={minute}>{String(minute).padStart(2, '0')}</option>)}
                    </select>
                    <select
                      aria-label={`Send time ${index + 1}: AM or PM`}
                      value={time.period}
                      onChange={(event) => updateRow(row.key, { period: event.target.value as Period })}
                      disabled={savingTimes}
                      className={SELECT}
                    >
                      <option value="AM">AM</option>
                      <option value="PM">PM</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => removeRow(row.key)}
                      disabled={savingTimes}
                      aria-label={`Remove send time ${sendTimeLabel(row.value)}`}
                      title="Remove this time"
                      className="rounded-md border border-slate-200 bg-white p-2 text-slate-500 transition-colors hover:bg-slate-50 hover:text-rose-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {repeated && (
            <p role="alert" className="mb-3 text-sm font-medium text-rose-600">{repeated} is listed twice.</p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={addRow}
              disabled={loading || savingTimes || rows.length >= MAX_TIMES}
              className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <Plus size={16} aria-hidden="true" />
              Add time
            </button>
            <button
              type="button"
              onClick={() => void saveTimes()}
              disabled={loading || savingTimes || !dirty || Boolean(repeated)}
              className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-bold text-white shadow-md shadow-indigo-200 transition-colors hover:bg-indigo-700 disabled:opacity-50"
            >
              <Save size={16} aria-hidden="true" />
              {savingTimes ? 'Saving…' : 'Save times'}
            </button>
            {dirty && !repeated && <span className="text-xs font-medium text-amber-600">Unsaved changes</span>}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            A time that has already passed today when you save it starts from tomorrow.
          </p>
        </div>
      </div>

      <p className="mb-5 text-sm text-slate-500">
        Each day's full report, with its link, is in the list above.
      </p>

      {incomplete && (
        <div role="status" className="mb-5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-800">
          Daily reports are on, but nothing will be sent until there is at least one send time and one recipient.
        </div>
      )}

      <p className="mb-2 text-sm font-semibold text-slate-800">Daily report recipients</p>
      <form onSubmit={addRecipient} className="mb-5 flex flex-wrap items-start gap-2">
        <div className="relative basis-full sm:basis-auto sm:min-w-[16rem] flex-1">
          <Mail size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            type="email"
            required
            maxLength={254}
            autoComplete="off"
            aria-label="Daily report recipient email address"
            placeholder="name@nxtwave.co.in"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={adding}
            className="w-full rounded-md border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60"
          />
        </div>
        <button
          type="submit"
          disabled={adding || !email.trim()}
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-md shadow-indigo-200 transition-colors hover:bg-indigo-700 disabled:opacity-60"
        >
          <Plus size={16} aria-hidden="true" />
          {adding ? 'Adding…' : 'Add'}
        </button>
      </form>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
        {loading ? (
          <p className="p-8 text-center text-sm font-medium text-slate-400">Loading recipients…</p>
        ) : data.emails.length === 0 ? (
          <p className="p-8 text-center text-sm font-medium text-slate-400">No daily report recipients yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.emails.map((value) => (
              <li key={value} className="flex items-center justify-between gap-4 p-4">
                <span className="flex min-w-0 items-center gap-2">
                  <Mail size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
                  <span className="truncate text-sm font-medium text-slate-700">{value}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setConfirmTarget(value)}
                  disabled={removing === value}
                  aria-label={`Remove ${value} from the daily report`}
                  title={`Remove ${value}`}
                  className="shrink-0 rounded-md border border-rose-100 bg-rose-50 p-2 text-rose-700 transition-colors hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500 disabled:opacity-50"
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {data.emails.length > 0 && (
        <p className="mt-2 text-xs text-slate-400">
          {data.emails.length} daily report {data.emails.length === 1 ? 'recipient' : 'recipients'}.
        </p>
      )}

      <ConfirmDialog
        open={Boolean(confirmTarget)}
        destructive
        busy={Boolean(removing)}
        title="Remove daily report recipient"
        message={`Stop sending the daily report to ${confirmTarget ?? 'this address'}?`}
        detail="They stay on any other list, such as the reporting partners."
        confirmLabel="Remove"
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => confirmTarget && removeRecipient(confirmTarget)}
      />
    </section>
  );
}
