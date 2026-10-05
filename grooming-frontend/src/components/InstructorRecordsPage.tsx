import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CalendarDays, CheckCircle2, CircleAlert, Clock, FileText, Image as ImageIcon, LogOut, TriangleAlert, XCircle } from 'lucide-react';
import { apiFetch, apiFetchAllPages, apiFetchCached, readStale } from '../api';
import { checkoutDateTimeLabel, formatAttendanceTime, localDateValue } from '../attendanceFilters';
import {
  checkoutVerdict,
  matchInstructorsByName,
  rangeSummaryLabel,
  RECORDS_PERIODS,
  recordDay,
  recordDayLabel,
  recordReportPath,
  recordsPagePath,
  recordsPath,
  recordsPeriodFromParam,
  recordsPeriodParams,
  recordsRange,
  recordsRangeProblem,
  sortRecordsNewestFirst,
  summarizeRecords,
  type RecordsPeriod,
  type RecordsRange,
} from '../lib/instructorRecords';
import { useLocation } from '../lib/useLocation';
import { closeChildPath, goToPath, writeQueryParams } from '../routes';
import { normalizeAttendanceStatus } from '../status';
import type { AttendanceRecord, College, Instructor } from '../types';
import PhotoViewer from './PhotoViewer';

const INSTRUCTORS_PATH = '/api/v2/instructors?include_feedback=false';
const FIELD = 'h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';
const ICON = 'inline-flex h-8 w-8 items-center justify-center rounded-md border focus:outline-none focus:ring-2';
const CHECK_IN_STYLE = 'border-indigo-100 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 focus:ring-indigo-500';
const CHECK_OUT_STYLE = 'border-rose-100 bg-rose-50 text-rose-700 hover:bg-rose-100 focus:ring-rose-500';

const ATTIRE_LABELS: Record<string, string> = {
  FORMAL: 'Formal',
  SAREE: 'Saree',
  KURTI_WITH_DUPATTA: 'Kurti + Dupatta',
  ABAYA: 'Abaya',
  KURTA_PAJAMA: 'Kurta + Payjama',
};

function Verdict({ status }: { status: string | null | undefined }) {
  switch (normalizeAttendanceStatus(status)) {
    case 'compliant':
      return <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-700"><CheckCircle2 size={12} aria-hidden="true" /> Compliant</span>;
    case 'non_compliant':
      return <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-700"><XCircle size={12} aria-hidden="true" /> Non-compliant</span>;
    case 'unassessed':
      return <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-700"><CircleAlert size={12} aria-hidden="true" /> Not assessed</span>;
    case 'error':
      return <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600"><TriangleAlert size={12} aria-hidden="true" /> Analysis error</span>;
    default:
      return <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-600"><Clock size={12} aria-hidden="true" /> Pending AI</span>;
  }
}

function Links({ record, name, onPhoto }: { record: AttendanceRecord; name: string; onPhoto: (kind: 'checkin' | 'checkout') => void }) {
  const day = recordDayLabel(recordDay(record));
  const checkinReport = recordReportPath(record, 'checkin');
  const checkoutReport = recordReportPath(record, 'checkout');
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {record.check_in_photo_key && (
        <button type="button" title="Check-in photo" aria-label={`Check-in photo of ${name} on ${day}`} onClick={() => onPhoto('checkin')} className={`${ICON} ${CHECK_IN_STYLE}`}>
          <ImageIcon size={15} aria-hidden="true" />
        </button>
      )}
      {record.check_out_photo_key && (
        <button type="button" title="Check-out photo" aria-label={`Check-out photo of ${name} on ${day}`} onClick={() => onPhoto('checkout')} className={`${ICON} ${CHECK_OUT_STYLE}`}>
          <LogOut size={15} aria-hidden="true" />
        </button>
      )}
      {checkinReport && (
        <a href={checkinReport} target="_blank" rel="noopener noreferrer" title="Check-in report" aria-label={`Check-in report of ${name} on ${day}`} className={`${ICON} ${CHECK_IN_STYLE}`}>
          <FileText size={15} aria-hidden="true" />
        </a>
      )}
      {checkoutReport && (
        <a href={checkoutReport} target="_blank" rel="noopener noreferrer" title="Check-out report" aria-label={`Check-out report of ${name} on ${day}`} className={`${ICON} ${CHECK_OUT_STYLE}`}>
          <FileText size={15} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

export interface RecordsInstructor {
  id: string;
  name: string;
  role?: string;
  institute?: string;
}

function RecordsTable({ instructor }: { instructor: RecordsInstructor }) {
  const today = useMemo(() => localDateValue(), []);
  const [period, setPeriod] = useState<RecordsPeriod>(() => recordsPeriodFromParam(new URLSearchParams(window.location.search).get('period')));
  const [custom, setCustom] = useState<RecordsRange>(() => {
    const params = new URLSearchParams(window.location.search);
    const fallback = recordsRange('last_10', today);
    return { from: params.get('from') || fallback.from, to: params.get('to') || fallback.to };
  });
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [photo, setPhoto] = useState<{ record: AttendanceRecord; kind: 'checkin' | 'checkout' } | null>(null);

  const range = recordsRange(period, today, custom);
  const problem = period === 'custom' ? recordsRangeProblem(range) : '';

  useEffect(() => {
    writeQueryParams(recordsPeriodParams(period, custom));
  }, [period, custom]);

  useEffect(() => {
    if (problem) {
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    setError('');
    apiFetch<AttendanceRecord[]>(recordsPath(instructor.id, { from: range.from, to: range.to }))
      .then((data) => { if (active) setRecords(Array.isArray(data) ? sortRecordsNewestFirst(data) : []); })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'The records could not be loaded.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [instructor.id, range.from, range.to, problem]);

  const choosePeriod = (next: RecordsPeriod) => {
    if (next === 'custom' && period !== 'custom') setCustom(range.from ? range : recordsRange('last_10', today));
    setPeriod(next);
  };

  const summary = summarizeRecords(records);
  const empty = problem ? 'Choose the dates to show.' : loading ? 'Loading records…' : error ? '' : 'No check-ins in these dates.';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
        <select id="instructor-records-period" value={period} onChange={(event) => choosePeriod(event.target.value as RecordsPeriod)} aria-label="Dates" className={FIELD}>
          {RECORDS_PERIODS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {period === 'custom' && (
          <span className="flex flex-wrap items-center gap-2">
            <input id="instructor-records-from" type="date" value={custom.from} max={custom.to || today} onChange={(event) => setCustom((current) => ({ ...current, from: event.target.value }))} aria-label="From date" className={FIELD} />
            <span className="text-xs font-semibold text-slate-500">to</span>
            <input id="instructor-records-to" type="date" value={custom.to} min={custom.from || undefined} max={today} onChange={(event) => setCustom((current) => ({ ...current, to: event.target.value }))} aria-label="To date" className={FIELD} />
          </span>
        )}
        {!problem && (
          <p className="text-sm text-slate-600 sm:ml-auto" aria-live="polite">
            <span className="font-semibold text-slate-800">{rangeSummaryLabel(range)}</span>
            {!loading && !error && (
              <>
                {' · '}{summary.total} {summary.total === 1 ? 'check-in' : 'check-ins'}
                {' · '}<span className="text-emerald-700">{summary.compliant} compliant</span>
                {' · '}<span className="text-rose-700">{summary.nonCompliant} non-compliant</span>
                {' · '}{summary.checkedOut} checked out
              </>
            )}
          </p>
        )}
      </div>

      {problem && <div role="alert" className="mx-4 mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-800">{problem}</div>}
      {!problem && error && <div role="alert" className="mx-4 mt-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {problem || loading || !records.length ? (
          empty && <p className="p-8 text-center text-sm text-slate-400">{empty}</p>
        ) : (
          <>
            <ul className="flex flex-col gap-3 md:hidden">
              {records.map((record) => (
                <li key={record._id} className="rounded-md border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-bold text-slate-800">{recordDayLabel(recordDay(record))}</span>
                    {record.attire_type && ATTIRE_LABELS[record.attire_type] && <span className="text-xs font-semibold text-violet-700">{ATTIRE_LABELS[record.attire_type]}</span>}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="font-bold uppercase tracking-wide text-slate-400">Check-in</div>
                      <div className="mt-0.5 font-semibold text-slate-700">{formatAttendanceTime(record.check_in_time)}</div>
                      <div className="mt-1"><Verdict status={record.status} /></div>
                    </div>
                    <div>
                      <div className="font-bold uppercase tracking-wide text-slate-400">Check-out</div>
                      <div className="mt-0.5 font-semibold text-slate-700">{checkoutDateTimeLabel(record.check_in_time, record.check_out_time, record.checkout_status)}</div>
                      {checkoutVerdict(record) && <div className="mt-1"><Verdict status={checkoutVerdict(record)} /></div>}
                    </div>
                  </div>
                  {record.remarks && <p className="mt-2 text-xs leading-relaxed text-slate-600">{record.remarks}</p>}
                  <div className="mt-2"><Links record={record} name={instructor.name} onPhoto={(kind) => setPhoto({ record, kind })} /></div>
                </li>
              ))}
            </ul>
            <table className="hidden w-full text-left text-sm md:table">
              <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-3">Date</th>
                  <th scope="col" className="px-3 py-3">Check-in</th>
                  <th scope="col" className="px-3 py-3">Check-out</th>
                  <th scope="col" className="px-3 py-3">Attire</th>
                  <th scope="col" className="px-3 py-3">Institute</th>
                  <th scope="col" className="px-3 py-3">Remarks</th>
                  <th scope="col" className="px-3 py-3">Photos &amp; reports</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 align-top">
                {records.map((record) => (
                  <tr key={record._id}>
                    <td className="whitespace-nowrap px-3 py-3 font-semibold text-slate-800">{recordDayLabel(recordDay(record))}</td>
                    <td className="px-3 py-3">
                      <div className="whitespace-nowrap font-semibold text-slate-700">{formatAttendanceTime(record.check_in_time)}</div>
                      <div className="mt-1"><Verdict status={record.status} /></div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="whitespace-nowrap font-semibold text-slate-700">{checkoutDateTimeLabel(record.check_in_time, record.check_out_time, record.checkout_status)}</div>
                      {checkoutVerdict(record) && <div className="mt-1"><Verdict status={checkoutVerdict(record)} /></div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-600">{(record.attire_type && ATTIRE_LABELS[record.attire_type]) || '--'}</td>
                    <td className="px-3 py-3 text-slate-600">{record.college_name || '--'}</td>
                    <td className="max-w-md px-3 py-3 text-xs leading-relaxed text-slate-600">{record.remarks || '--'}</td>
                    <td className="px-3 py-3"><Links record={record} name={instructor.name} onPhoto={(kind) => setPhoto({ record, kind })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {photo && (
        <PhotoViewer
          attendanceId={photo.record._id}
          kind={photo.kind}
          title={instructor.name}
          subtitle={`${photo.kind === 'checkin' ? 'Check-in' : 'Check-out'} · ${recordDayLabel(recordDay(photo.record))}`}
          onClose={() => setPhoto(null)}
        />
      )}
    </div>
  );
}

export default function InstructorRecordsPage() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const urlId = params.get('id') ?? '';
  const urlName = params.get('name') ?? '';
  const cachedInstructors = readStale<Instructor[]>(INSTRUCTORS_PATH);
  const cachedColleges = readStale<College[]>('/api/v2/colleges');
  const [instructors, setInstructors] = useState<Instructor[]>(Array.isArray(cachedInstructors) ? cachedInstructors : []);
  const [colleges, setColleges] = useState<College[]>(Array.isArray(cachedColleges) ? cachedColleges : []);
  const [listLoaded, setListLoaded] = useState(Array.isArray(cachedInstructors));

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      apiFetchAllPages<Instructor>(INSTRUCTORS_PATH, { pageSize: 1_000, cacheMs: 15_000, signal: controller.signal }),
      apiFetchCached<College[]>('/api/v2/colleges', { signal: controller.signal }).catch(() => [] as College[]),
    ])
      .then(([instructorData, collegeData]) => {
        if (controller.signal.aborted) return;
        if (Array.isArray(instructorData)) setInstructors(instructorData);
        if (Array.isArray(collegeData)) setColleges(collegeData);
      })
      .catch(() => undefined)
      .finally(() => { if (!controller.signal.aborted) setListLoaded(true); });
    return () => controller.abort();
  }, []);

  const byId = urlId ? instructors.find((ins) => String(ins._id) === urlId) : undefined;
  const nameMatches = useMemo(
    () => (urlId ? [] : matchInstructorsByName(instructors, urlName)),
    [instructors, urlId, urlName],
  );
  const resolved = byId ?? (nameMatches.length === 1 ? nameMatches[0] : undefined);
  const resolvedId = resolved ? String(resolved._id) : urlId;

  useEffect(() => {
    if (!urlId && resolved) writeQueryParams({ name: resolved.name, id: String(resolved._id) });
  }, [urlId, resolved]);

  const instituteFor = (ins: Instructor): string =>
    ins.institute_name
    || colleges.find((college) => String(college._id) === String(ins.college_id))?.name
    || '';

  const instructor: RecordsInstructor | null = resolvedId
    ? {
      id: resolvedId,
      name: resolved?.name || urlName || 'Instructor',
      role: resolved ? resolved.instructor_role || resolved.role : undefined,
      institute: resolved ? instituteFor(resolved) : undefined,
    }
    : null;

  const goBack = () => closeChildPath('/instructors');

  let body;
  if (instructor) {
    body = <RecordsTable key={instructor.id} instructor={instructor} />;
  } else if (!listLoaded) {
    body = <p className="rounded-md border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">Loading instructor…</p>;
  } else if (nameMatches.length > 1) {
    body = (
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <p className="text-sm font-semibold text-slate-700">More than one instructor is named {urlName}. Choose one:</p>
        <ul className="mt-3 flex flex-col gap-2">
          {nameMatches.map((ins) => (
            <li key={ins._id}>
              <button
                type="button"
                onClick={() => goToPath(recordsPagePath({ id: String(ins._id), name: ins.name }), { replace: true, state: window.history.state })}
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              >
                <span className="font-bold text-slate-800">{ins.name}</span>
                <span className="block text-xs text-slate-500">{[ins.instructor_role || ins.role, instituteFor(ins), ins.employee_id].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  } else {
    body = (
      <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-800">
        {urlName ? `No instructor named ${urlName} was found.` : 'Choose an instructor from Instructors to see their records.'}
      </div>
    );
  }

  return (
    <section className="flex h-full w-full flex-col gap-4" aria-labelledby="instructor-records-title">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={goBack}
          aria-label="Back to Instructors"
          className="flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <div className="min-w-0">
          <h2 id="instructor-records-title" className="flex items-center gap-2 text-lg font-bold text-slate-800 sm:text-xl">
            <CalendarDays size={20} className="shrink-0 text-indigo-600" aria-hidden="true" />
            <span className="truncate">{instructor ? `${instructor.name} · Records` : 'Instructor records'}</span>
          </h2>
          {instructor && (instructor.role || instructor.institute) && (
            <p className="text-xs text-slate-500">{[instructor.role, instructor.institute].filter(Boolean).join(' · ')}</p>
          )}
        </div>
      </div>
      {body}
    </section>
  );
}
