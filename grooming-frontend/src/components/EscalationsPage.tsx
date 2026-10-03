import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ChevronRight, Download, FileText, Image as ImageIcon, LogOut, Search, ShieldAlert, X } from 'lucide-react';
import { apiFetch } from '../api';
import { saveCsvFile } from '../attendanceExport';
import { formatAttendanceTime, localDateValue } from '../attendanceFilters';
import {
  dayLabel,
  ESCALATION_PERIODS,
  escalationCsv,
  escalationFileName,
  escalationsPath,
  filterEscalationRows,
  groupByPerson,
  periodRange,
  rangeLabel,
  rangeProblem,
  rowReportPath,
  runsOf,
  shortDayLabel,
  VERDICT_LABELS,
  WEEKDAYS,
  type EscalatedPerson,
  type EscalationPeriod,
  type EscalationReport,
  type EscalationRow,
  type PeriodRange,
} from '../lib/escalationReport';
import PhotoViewer from './PhotoViewer';
import { useToast } from './useToast';

const FIELD = 'h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';
const ICON = 'inline-flex h-7 w-7 items-center justify-center rounded-md border focus:outline-none focus:ring-2';
const CHECK_IN_STYLE = 'border-indigo-100 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 focus:ring-indigo-500';
const CHECK_OUT_STYLE = 'border-rose-100 bg-rose-50 text-rose-700 hover:bg-rose-100 focus:ring-rose-500';

type PhotoTarget = { row: EscalationRow; kind: 'checkin' | 'checkout' };

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

function DayLinks({ row, onPhoto }: { row: EscalationRow; onPhoto: (target: PhotoTarget) => void }) {
  const checkinReport = rowReportPath(row, 'checkin');
  const checkoutReport = rowReportPath(row, 'checkout');
  const when = dayLabel(row.date);
  return (
    <div className="flex flex-wrap items-center gap-1" onClick={(event) => event.stopPropagation()}>
      {row.has_checkin_photo && (
        <button type="button" title="Check-in photo" aria-label={`Check-in photo of ${row.name} on ${when}`} onClick={() => onPhoto({ row, kind: 'checkin' })} className={`${ICON} ${CHECK_IN_STYLE}`}>
          <ImageIcon size={14} aria-hidden="true" />
        </button>
      )}
      {row.has_checkout_photo && (
        <button type="button" title="Check-out photo" aria-label={`Check-out photo of ${row.name} on ${when}`} onClick={() => onPhoto({ row, kind: 'checkout' })} className={`${ICON} ${CHECK_OUT_STYLE}`}>
          <LogOut size={14} aria-hidden="true" />
        </button>
      )}
      {checkinReport && (
        <a href={checkinReport} target="_blank" rel="noopener noreferrer" title="Check-in report" aria-label={`Check-in report of ${row.name} on ${when}`} className={`${ICON} ${CHECK_IN_STYLE}`}>
          <FileText size={14} aria-hidden="true" />
        </a>
      )}
      {checkoutReport && (
        <a href={checkoutReport} target="_blank" rel="noopener noreferrer" title="Check-out report" aria-label={`Check-out report of ${row.name} on ${when}`} className={`${ICON} ${CHECK_OUT_STYLE}`}>
          <FileText size={14} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

function Half({ label, time, status, remarks }: { label: string; time: string | null; status: string | null; remarks: string | null }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-slate-700 tabular-nums">{time ? formatAttendanceTime(time) : '--'}</span>
        <Verdict status={status} />
      </div>
      {remarks && <p className="mt-1.5 whitespace-pre-line text-xs leading-relaxed text-slate-600">{remarks}</p>}
    </div>
  );
}

function PersonDetail({ person, range, photoOpen, onPhoto, onClose }: {
  person: EscalatedPerson;
  range: PeriodRange;
  photoOpen: boolean;
  onPhoto: (target: PhotoTarget) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const runs = runsOf(person.days);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !photoOpen) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [photoOpen, onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="escalation-person-title"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-md bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 id="escalation-person-title" className="flex items-center gap-2 text-lg font-bold text-slate-800">
              <ShieldAlert size={18} className="shrink-0 text-rose-600" aria-hidden="true" />
              <span className="truncate">{person.name}</span>
            </h2>
            <p className="text-xs text-slate-500">
              {[person.role, person.institute].filter(Boolean).join(' · ')}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {person.days.length} failed {person.days.length === 1 ? 'check-in' : 'check-ins'} in {rangeLabel(range.from, range.to)}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close escalation details"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">
          {runs.map((run) => (
            <section key={run.run_start} aria-label={`Run from ${dayLabel(run.run_start)}`}>
              <h3 className="text-sm font-bold text-slate-800">
                {run.run_length} non-compliant check-ins in a row, from {shortDayLabel(run.run_start)}
              </h3>
              {run.days.length < run.run_length && (
                <p className="text-xs text-slate-500">
                  {run.run_length - run.days.length} of its days fall outside the selected dates and are not shown.
                </p>
              )}
              <ol className="mt-2 flex flex-col gap-2">
                {run.days.map((day) => (
                  <li key={day.attendance_id} className="rounded-md border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex whitespace-nowrap rounded-full bg-rose-600 px-2 py-0.5 text-xs font-bold text-white">
                          Day {day.run_day} of {day.run_length}
                        </span>
                        <span className="text-sm font-semibold text-slate-800">{day.weekday}, {dayLabel(day.date)}</span>
                      </div>
                      <DayLinks row={day} onPhoto={onPhoto} />
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Half label="Check-in" time={day.check_in_time} status={day.check_in_status} remarks={day.check_in_remarks} />
                      <Half label="Check-out" time={day.check_out_time} status={day.check_out_status} remarks={day.check_out_remarks} />
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function EscalationsPage({ onBack }: { onBack: () => void }) {
  const toast = useToast();
  const today = useMemo(() => localDateValue(), []);
  const [period, setPeriod] = useState<EscalationPeriod>('this_week');
  const [custom, setCustom] = useState<PeriodRange>(() => periodRange('this_week', today));
  const [report, setReport] = useState<EscalationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [college, setCollege] = useState('');
  const [weekday, setWeekday] = useState('');
  const [photo, setPhoto] = useState<PhotoTarget | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const range = periodRange(period, today, custom);
  const problem = period === 'custom' ? rangeProblem(range) : '';

  useEffect(() => {
    if (problem) {
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    setError('');
    apiFetch<EscalationReport>(escalationsPath({ from: range.from, to: range.to }))
      .then((data) => { if (active) setReport(data); })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'The escalations could not be loaded.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [range.from, range.to, problem]);

  const rows = useMemo(
    () => filterEscalationRows(report?.rows ?? [], { search, college, weekday }),
    [report, search, college, weekday],
  );
  const people = useMemo(() => groupByPerson(rows), [rows]);
  const openPerson = useMemo(
    () => (openId ? groupByPerson((report?.rows ?? []).filter((row) => row.instructor_id === openId))[0] ?? null : null),
    [openId, report],
  );
  const filtered = Boolean(search || college || weekday);

  const choosePeriod = (next: EscalationPeriod) => {
    if (next === 'custom' && period !== 'custom') setCustom(range);
    setPeriod(next);
  };

  const clearFilters = () => {
    setSearch('');
    setCollege('');
    setWeekday('');
  };

  const exportRows = () => {
    saveCsvFile(escalationFileName(range), escalationCsv(rows, range, window.location.origin)).catch((exportError) => {
      toast.error('Could not export the escalations', {
        detail: exportError instanceof Error ? exportError.message : String(exportError),
      });
    });
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, person: EscalatedPerson) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpenId(person.instructor_id);
    }
  };

  const emptyRow = (text: string) => (
    <tr><td colSpan={4} className="p-8 text-center text-slate-400">{text}</td></tr>
  );

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
            Non-compliant at check-in 3 or more times in a row in a week. Days not at work are skipped.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="relative w-full min-w-0 sm:w-72">
          <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            id="escalations-search"
            type="search"
            maxLength={120}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search instructor or institute…"
            aria-label="Search instructor or institute"
            className={`${FIELD} w-full pl-8`}
          />
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto sm:justify-end">
          <select id="escalations-period" value={period} onChange={(event) => choosePeriod(event.target.value as EscalationPeriod)} aria-label="Dates" className={FIELD}>
            {ESCALATION_PERIODS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {period === 'custom' && (
            <span className="flex flex-wrap items-center gap-2">
              <input
                id="escalations-from"
                type="date"
                value={custom.from}
                max={custom.to || undefined}
                onChange={(event) => setCustom((current) => ({ ...current, from: event.target.value }))}
                aria-label="From date"
                className={FIELD}
              />
              <span className="text-xs font-semibold text-slate-500">to</span>
              <input
                id="escalations-to"
                type="date"
                value={custom.to}
                min={custom.from || undefined}
                onChange={(event) => setCustom((current) => ({ ...current, to: event.target.value }))}
                aria-label="To date"
                className={FIELD}
              />
            </span>
          )}
          <select id="escalations-institute" value={college} onChange={(event) => setCollege(event.target.value)} aria-label="Institute" className={`${FIELD} min-w-0 max-w-full sm:w-60`}>
            <option value="">All institutes</option>
            {(report?.institutes ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <select id="escalations-day" value={weekday} onChange={(event) => setWeekday(event.target.value)} aria-label="Day" className={FIELD}>
            <option value="">All days</option>
            {WEEKDAYS.map((day) => <option key={day} value={day}>{day}</option>)}
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
            disabled={loading || Boolean(problem) || rows.length === 0}
            title={rows.length ? `Download ${rows.length} failed check-ins as CSV` : 'Nothing to export'}
            className="flex h-10 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={16} aria-hidden="true" />
            Export
          </button>
        </div>
      </div>

      {problem && <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-800">{problem}</div>}
      {!problem && error && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}

      {!problem && (
        <p className="text-sm text-slate-600" aria-live="polite">
          <span className="font-semibold text-slate-800">{rangeLabel(range.from, range.to)}</span>
          {!loading && !error && (
            <>
              {' · '}
              {people.length} {people.length === 1 ? 'instructor' : 'instructors'} escalated
              {' · '}
              {rows.length} failed {rows.length === 1 ? 'check-in' : 'check-ins'}
            </>
          )}
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm md:min-w-[720px]">
          <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-3">Instructor</th>
              <th scope="col" className="hidden px-3 py-3 md:table-cell">Institute</th>
              <th scope="col" className="px-3 py-3">Dates</th>
              <th scope="col" className="w-10 px-3 py-3"><span className="sr-only">Details</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {problem ? emptyRow('Choose the dates to show.')
              : loading ? emptyRow('Loading escalations…')
                : !report?.rows.length ? emptyRow('Nobody was escalated in these dates.')
                  : !people.length ? emptyRow('No escalations match the selected filters.')
                    : people.map((person) => (
                      <tr
                        key={person.instructor_id}
                        onClick={() => setOpenId(person.instructor_id)}
                        onKeyDown={(event) => onRowKeyDown(event, person)}
                        tabIndex={0}
                        aria-label={`Open escalation details for ${person.name}`}
                        className="cursor-pointer align-top hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500"
                      >
                        <td className="px-3 py-3">
                          <span className="block font-bold text-slate-800">{person.name}</span>
                          {person.role && <span className="block text-xs text-slate-500">{person.role}</span>}
                          <span className="block text-xs text-slate-500 md:hidden">{person.institute}</span>
                          <span className="mt-1 block text-xs font-semibold text-rose-700">
                            {person.days.length} failed {person.days.length === 1 ? 'check-in' : 'check-ins'}
                          </span>
                        </td>
                        <td className="hidden px-3 py-3 text-slate-600 md:table-cell">{person.institute}</td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-2">
                            {person.days.map((day) => (
                              <div key={day.attendance_id} className="rounded-md border border-rose-100 bg-rose-50/40 px-2 py-1.5">
                                <div className="flex items-center gap-1.5 whitespace-nowrap" title={`Day ${day.run_day} of ${day.run_length} in a row`}>
                                  <span className="text-xs font-bold text-slate-800">{shortDayLabel(day.date)}</span>
                                  <span className="rounded-full bg-rose-600 px-1.5 text-[10px] font-bold leading-4 text-white">
                                    {day.run_day}/{day.run_length}
                                  </span>
                                </div>
                                <div className="mt-1.5">
                                  <DayLinks row={day} onPhoto={setPhoto} />
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-slate-400">
                          <ChevronRight size={18} aria-hidden="true" />
                        </td>
                      </tr>
                    ))}
          </tbody>
        </table>
      </div>

      {openPerson && (
        <PersonDetail
          person={openPerson}
          range={range}
          photoOpen={Boolean(photo)}
          onPhoto={setPhoto}
          onClose={() => setOpenId(null)}
        />
      )}

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
