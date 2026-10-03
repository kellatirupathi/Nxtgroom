import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, FileText, Image as ImageIcon, LogOut, Search, ShieldAlert, X } from 'lucide-react';
import { apiFetch } from '../api';
import { saveCsvFile } from '../attendanceExport';
import { formatAttendanceTime, localDateValue, weekStartOf } from '../attendanceFilters';
import {
  CHECKOUT_FILTER_OPTIONS,
  dayLabel,
  escalatedInstructorCount,
  escalationCsv,
  escalationFileName,
  filterEscalationRows,
  rowReportPath,
  VERDICT_LABELS,
  weekOptions,
  weekRangeLabel,
  WEEKDAYS,
  type CheckoutFilter,
  type EscalationReport,
  type EscalationRow,
} from '../lib/escalationReport';
import PhotoViewer from './PhotoViewer';
import { useToast } from './useToast';

const FIELD = 'h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

function Verdict({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-slate-400">No check-out</span>;
  const style = status === 'compliant'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : status === 'non_compliant'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : 'bg-slate-50 text-slate-600 border-slate-200';
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-bold ${style}`}>
      {VERDICT_LABELS[status] || status}
    </span>
  );
}

function Half({ time, status }: { time: string | null; status: string | null }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="text-sm font-bold text-slate-700 tabular-nums">{time ? formatAttendanceTime(time) : '--'}</span>
      <Verdict status={status} />
    </div>
  );
}

const ICON = 'inline-flex h-8 w-8 items-center justify-center rounded-md border focus:outline-none focus:ring-2';

/**
 * Everyone escalated to the reporting partners in a chosen week, opened from
 * "View all" on the Dashboard and not from the menu. One row per failed
 * check-in of each run, with that day's check-in and check-out, their
 * photographs and their reports.
 */
export default function EscalationsPage({ onBack }: { onBack: () => void }) {
  const toast = useToast();
  const today = useMemo(() => localDateValue(), []);
  const [week, setWeek] = useState(() => weekStartOf(today));
  const [report, setReport] = useState<EscalationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [college, setCollege] = useState('');
  const [weekday, setWeekday] = useState('');
  const [checkout, setCheckout] = useState<CheckoutFilter>('');
  const [photo, setPhoto] = useState<{ row: EscalationRow; kind: 'checkin' | 'checkout' } | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    apiFetch<EscalationReport>(`/api/v2/dashboard/escalations?week=${encodeURIComponent(week)}`)
      .then((data) => { if (active) setReport(data); })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'The escalations could not be loaded.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [week]);

  const rows = useMemo(
    () => filterEscalationRows(report?.rows ?? [], { search, college, weekday, checkout }),
    [report, search, college, weekday, checkout],
  );
  const filtered = Boolean(search || college || weekday || checkout);
  const options = weekOptions(today, 12, week);

  const clearFilters = () => {
    setSearch('');
    setCollege('');
    setWeekday('');
    setCheckout('');
  };

  const exportRows = () => {
    saveCsvFile(escalationFileName(week), escalationCsv(rows, week, window.location.origin)).catch((exportError) => {
      toast.error('Could not export the escalations', {
        detail: exportError instanceof Error ? exportError.message : String(exportError),
      });
    });
  };

  return (
    <section className="w-full flex flex-col gap-4" aria-labelledby="escalations-title">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to Dashboard"
          className="flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <div className="min-w-0">
          <h2 id="escalations-title" className="flex items-center gap-2 text-lg font-bold text-slate-800 sm:text-xl">
            <ShieldAlert size={20} className="text-rose-600" aria-hidden="true" />
            Escalations
          </h2>
          <p className="text-xs text-slate-500">
            Non-compliant at check-in 3 or more times in a row in the week. Days not at work are skipped.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="escalations-week">Week</label>
        <select id="escalations-week" value={week} onChange={(event) => setWeek(event.target.value)} className={`${FIELD} min-w-0 max-w-full`}>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-500">
          or the week of
          <input
            id="escalations-date"
            type="date"
            max={today}
            onChange={(event) => { if (event.target.value) setWeek(weekStartOf(event.target.value)); }}
            aria-label="Choose any date to show its week"
            className={FIELD}
          />
        </label>
        <span className="relative min-w-0 flex-1 sm:flex-none">
          <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            id="escalations-search"
            type="search"
            maxLength={120}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search instructor or institute…"
            aria-label="Search instructor or institute"
            className={`${FIELD} w-full pl-8 sm:w-60`}
          />
        </span>
        <select id="escalations-institute" value={college} onChange={(event) => setCollege(event.target.value)} aria-label="Institute" className={FIELD}>
          <option value="">All institutes</option>
          {(report?.institutes ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select id="escalations-day" value={weekday} onChange={(event) => setWeekday(event.target.value)} aria-label="Day" className={FIELD}>
          <option value="">All days</option>
          {WEEKDAYS.map((day) => <option key={day} value={day}>{day}</option>)}
        </select>
        <select id="escalations-checkout" value={checkout} onChange={(event) => setCheckout(event.target.value as CheckoutFilter)} aria-label="Check-out" className={FIELD}>
          <option value="">Any check-out</option>
          {CHECKOUT_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {filtered && (
          <button
            type="button"
            onClick={clearFilters}
            aria-label="Clear filters"
            className="flex h-10 items-center gap-1.5 rounded-md border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-700 hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-rose-500/20"
          >
            <X size={16} aria-hidden="true" />
            Clear
          </button>
        )}
        <button
          type="button"
          onClick={exportRows}
          disabled={loading || rows.length === 0}
          title={rows.length ? `Download ${rows.length} rows as CSV` : 'Nothing to export'}
          className="flex h-10 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50 sm:ml-auto"
        >
          <Download size={16} aria-hidden="true" />
          Export
        </button>
      </div>

      {error && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}

      <p className="text-sm text-slate-600" aria-live="polite">
        <span className="font-semibold text-slate-800">{weekRangeLabel(week)}</span>
        {!loading && !error && (
          <>
            {' · '}
            {escalatedInstructorCount(rows)} {escalatedInstructorCount(rows) === 1 ? 'instructor' : 'instructors'} escalated
            {' · '}
            {rows.length} failed {rows.length === 1 ? 'check-in' : 'check-ins'}
          </>
        )}
      </p>

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-3">Instructor</th>
              <th scope="col" className="px-3 py-3">Institute</th>
              <th scope="col" className="px-3 py-3">Date</th>
              <th scope="col" className="px-3 py-3">Day</th>
              <th scope="col" className="px-3 py-3">Escalation</th>
              <th scope="col" className="px-3 py-3">Check-in</th>
              <th scope="col" className="px-3 py-3">Check-out</th>
              <th scope="col" className="px-3 py-3">Photos</th>
              <th scope="col" className="px-3 py-3">Reports</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={9} className="p-8 text-center text-slate-400">Loading escalations…</td></tr>
            ) : !report?.rows.length ? (
              <tr><td colSpan={9} className="p-8 text-center text-slate-400">Nobody was escalated in this week.</td></tr>
            ) : !rows.length ? (
              <tr><td colSpan={9} className="p-8 text-center text-slate-400">No escalations match the selected filters.</td></tr>
            ) : rows.map((row) => {
              const checkinReport = rowReportPath(row, 'checkin');
              const checkoutReport = rowReportPath(row, 'checkout');
              return (
                <tr key={row.attendance_id} className="align-top hover:bg-slate-50">
                  <td className="px-3 py-3">
                    <span className="block font-bold text-slate-800">{row.name}</span>
                    {row.role && <span className="block text-xs text-slate-500">{row.role}</span>}
                  </td>
                  <td className="px-3 py-3 text-slate-600">{row.institute}</td>
                  <td className="px-3 py-3 whitespace-nowrap font-medium text-slate-700">{dayLabel(row.date)}</td>
                  <td className="px-3 py-3 text-slate-600">{row.weekday}</td>
                  <td className="px-3 py-3">
                    <span className="inline-flex whitespace-nowrap rounded-full bg-rose-600 px-2 py-0.5 text-xs font-bold text-white">
                      Day {row.run_day} of {row.run_length}
                    </span>
                  </td>
                  <td className="px-3 py-3"><Half time={row.check_in_time} status={row.check_in_status} /></td>
                  <td className="px-3 py-3"><Half time={row.check_out_time} status={row.check_out_status} /></td>
                  <td className="px-3 py-3">
                    <div className="flex gap-1.5">
                      {row.has_checkin_photo ? (
                        <button type="button" title="Check-in photo" aria-label={`Check-in photo of ${row.name} on ${dayLabel(row.date)}`} onClick={() => setPhoto({ row, kind: 'checkin' })} className={`${ICON} border-indigo-100 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 focus:ring-indigo-500`}>
                          <ImageIcon size={15} aria-hidden="true" />
                        </button>
                      ) : <span className="text-xs text-slate-300">--</span>}
                      {row.has_checkout_photo && (
                        <button type="button" title="Check-out photo" aria-label={`Check-out photo of ${row.name} on ${dayLabel(row.date)}`} onClick={() => setPhoto({ row, kind: 'checkout' })} className={`${ICON} border-rose-100 bg-rose-50 text-rose-700 hover:bg-rose-100 focus:ring-rose-500`}>
                          <LogOut size={15} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex gap-1.5">
                      {checkinReport ? (
                        <a href={checkinReport} target="_blank" rel="noopener noreferrer" title="Check-in report" aria-label={`Check-in report of ${row.name} on ${dayLabel(row.date)}`} className={`${ICON} border-indigo-100 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 focus:ring-indigo-500`}>
                          <FileText size={15} aria-hidden="true" />
                        </a>
                      ) : <span className="text-xs text-slate-300">--</span>}
                      {checkoutReport && (
                        <a href={checkoutReport} target="_blank" rel="noopener noreferrer" title="Check-out report" aria-label={`Check-out report of ${row.name} on ${dayLabel(row.date)}`} className={`${ICON} border-rose-100 bg-rose-50 text-rose-700 hover:bg-rose-100 focus:ring-rose-500`}>
                          <FileText size={15} aria-hidden="true" />
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {photo && (
        <PhotoViewer
          attendanceId={photo.row.attendance_id}
          kind={photo.kind}
          title={photo.row.name}
          subtitle={`${photo.kind === 'checkin' ? 'Check-in' : 'Check-out'} · ${dayLabel(photo.row.date)}`}
          onClose={() => setPhoto(null)}
        />
      )}
    </section>
  );
}
