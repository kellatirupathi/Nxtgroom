import { useEffect, useState, type FormEvent } from 'react';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import { localDateValue } from '../attendanceFilters';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './useToast';

const PATH = '/api/v2/settings/holidays';
const FIELD = 'h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface Holiday {
  date: string;
  name: string;
}

function holidayLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday}, ${day} ${MONTHS[month - 1]} ${year}`;
}

export default function HolidaySettings() {
  const toast = useToast();
  const today = localDateValue();
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Holiday | null>(null);
  const [showPast, setShowPast] = useState(false);

  useEffect(() => {
    let disposed = false;
    apiFetch<Holiday[]>(PATH)
      .then((data) => { if (!disposed) setHolidays(Array.isArray(data) ? data : []); })
      .catch((requestError) => {
        if (!disposed && (requestError as { status?: number })?.status !== 401) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, []);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!date || !name.trim()) return;
    setBusy(true);
    try {
      const saved = await apiJson<Holiday[]>(PATH, { method: 'POST', body: { date, name: name.trim() } });
      setHolidays(Array.isArray(saved) ? saved : []);
      toast.success('Holiday added', { detail: `${name.trim()} · ${holidayLabel(date)}` });
      setDate('');
      setName('');
    } catch (requestError) {
      toast.error('Could not add the holiday', { detail: requestError instanceof Error ? requestError.message : String(requestError) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      const saved = await apiFetch<Holiday[]>(`${PATH}/${encodeURIComponent(removing.date)}`, { method: 'DELETE' });
      setHolidays(Array.isArray(saved) ? saved : []);
      toast.success('Holiday removed', { detail: removing.name });
      setRemoving(null);
    } catch (requestError) {
      toast.error('Could not remove the holiday', { detail: requestError instanceof Error ? requestError.message : String(requestError) });
    } finally {
      setBusy(false);
    }
  };

  const upcoming = holidays.filter((holiday) => holiday.date >= today);
  const past = holidays.filter((holiday) => holiday.date < today).reverse();
  const shown = showPast ? past : upcoming;

  return (
    <section className="max-w-3xl" aria-labelledby="holidays-title">
      <h3 id="holidays-title" className="flex items-center gap-2 text-base font-bold text-slate-800">
        <CalendarOff size={18} className="text-indigo-600" aria-hidden="true" />
        Holidays
      </h3>
      <p className="mt-1 mb-4 text-sm text-slate-500">
        On these days no missed check-in or check-out emails are sent, and the day is skipped when counting escalations:
        a result that day neither counts towards three in a row nor breaks a run. Attendance can still be taken.
      </p>

      <form onSubmit={add} className="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-xs font-bold uppercase tracking-wide text-slate-500">
          Date
          <input type="date" required value={date} onChange={(event) => setDate(event.target.value)} className={FIELD} aria-label="Holiday date" />
        </label>
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs font-bold uppercase tracking-wide text-slate-500">
          Name
          <input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Diwali" className={FIELD} aria-label="Holiday name" />
        </label>
        <button
          type="submit"
          disabled={busy || loading || !date || !name.trim()}
          className="inline-flex h-10 items-center gap-1.5 rounded-md bg-indigo-600 px-4 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          <Plus size={16} aria-hidden="true" />
          Add holiday
        </button>
      </form>

      <div className="mb-2 flex items-center gap-2 text-sm">
        <button type="button" onClick={() => setShowPast(false)} aria-pressed={!showPast} className={`rounded-full px-3 py-1 font-semibold ${!showPast ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
          Upcoming ({upcoming.length})
        </button>
        <button type="button" onClick={() => setShowPast(true)} aria-pressed={showPast} className={`rounded-full px-3 py-1 font-semibold ${showPast ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
          Past ({past.length})
        </button>
      </div>

      <div className="rounded-md border border-slate-200 bg-white">
        {loading ? (
          <p className="p-6 text-center text-sm text-slate-400">Loading holidays…</p>
        ) : error ? (
          <p role="alert" className="m-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</p>
        ) : shown.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-400">{showPast ? 'No past holidays.' : 'No upcoming holidays. Add one above.'}</p>
        ) : (
          <ul className="divide-y divide-slate-100" aria-label={showPast ? 'Past holidays' : 'Upcoming holidays'}>
            {shown.map((holiday) => (
              <li key={holiday.date} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800">{holiday.name || 'Holiday'}</p>
                  <p className="text-xs text-slate-500">{holidayLabel(holiday.date)}{holiday.date === today ? ' · today' : ''}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setRemoving(holiday)}
                  disabled={busy}
                  aria-label={`Remove ${holiday.name || 'holiday'} on ${holidayLabel(holiday.date)}`}
                  title="Remove"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-rose-100 bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(removing)}
        destructive
        busy={busy}
        title="Remove holiday"
        message={`Remove ${removing?.name || 'this holiday'} on ${removing ? holidayLabel(removing.date) : ''}?`}
        detail="Reminder emails and escalations will count that day again."
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={() => void remove()}
      />
    </section>
  );
}
