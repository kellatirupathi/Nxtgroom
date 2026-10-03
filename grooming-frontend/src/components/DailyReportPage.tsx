import { useEffect, useState } from 'react';
import { Download, FileText, Image as ImageIcon, LogOut, Search, X } from 'lucide-react';
import { apiFetch } from '../api';
import { saveCsvFile } from '../attendanceExport';
import {
  DAY_STATUS_LABELS,
  DAY_STATUS_OPTIONS,
  dayInstitutes,
  dayReportCsv,
  dayReportFileName,
  filterDayRows,
  type DayReportResponse,
  type DayRow,
  type DayStatus,
} from '../lib/dayReport';
import BrandedLoader from './BrandedLoader';
import { useToast } from './useToast';

interface DailyReportPageProps {
  date: string;
  token: string;
}

type Kind = 'checkin' | 'checkout';

const REFRESH_MS = 60_000;

interface PhotoTarget {
  row: DayRow;
  kind: Kind;
}

function expiryLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

const ICON = 'inline-flex h-8 w-8 items-center justify-center rounded-md border focus:outline-none focus:ring-2';
const CHECKIN_ICON = `${ICON} border-indigo-100 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 focus:ring-indigo-500`;
const CHECKOUT_ICON = `${ICON} border-rose-100 bg-rose-50 text-rose-700 hover:bg-rose-100 focus:ring-rose-500`;

function Empty() {
  return <span className="inline-flex h-8 w-8 items-center justify-center text-slate-300">-</span>;
}

const STATUS_STYLE: Partial<Record<DayStatus, string>> = {
  compliant: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  non_compliant: 'border-rose-200 bg-rose-50 text-rose-700',
};

function StatusPill({ status }: { status: DayStatus }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-bold ${STATUS_STYLE[status] || 'border-slate-200 bg-slate-50 text-slate-600'}`}>
      {DAY_STATUS_LABELS[status] || status}
    </span>
  );
}

function PhotoIcons({ row, onOpen }: { row: DayRow; onOpen: (target: PhotoTarget) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {row.has_checkin_photo ? (
        <button
          type="button"
          title="Check-in photo"
          aria-label={`Check-in photo of ${row.name}`}
          onClick={() => onOpen({ row, kind: 'checkin' })}
          className={CHECKIN_ICON}
        >
          <ImageIcon size={16} aria-hidden="true" />
        </button>
      ) : <Empty />}
      {row.has_checkout_photo ? (
        <button
          type="button"
          title="Check-out photo"
          aria-label={`Check-out photo of ${row.name}`}
          onClick={() => onOpen({ row, kind: 'checkout' })}
          className={CHECKOUT_ICON}
        >
          <LogOut size={16} aria-hidden="true" />
        </button>
      ) : <Empty />}
    </div>
  );
}

function ReportIcons({ row }: { row: DayRow }) {
  return (
    <div className="flex items-center gap-1.5">
      {row.checkin_report_url ? (
        <a
          href={row.checkin_report_url}
          target="_blank"
          rel="noopener noreferrer"
          title="Check-in report"
          aria-label={`Check-in report of ${row.name}`}
          className={CHECKIN_ICON}
        >
          <FileText size={16} aria-hidden="true" />
        </a>
      ) : <Empty />}
      {row.checkout_report_url ? (
        <a
          href={row.checkout_report_url}
          target="_blank"
          rel="noopener noreferrer"
          title="Check-out report"
          aria-label={`Check-out report of ${row.name}`}
          className={CHECKOUT_ICON}
        >
          <FileText size={16} aria-hidden="true" />
        </a>
      ) : <Empty />}
    </div>
  );
}

function PhotoModal({ date, token, target, onClose }: { date: string; token: string; target: PhotoTarget; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    const path = `/api/v2/reports/daily/${encodeURIComponent(date)}/${encodeURIComponent(token)}/photo/${encodeURIComponent(target.row.attendance_id)}/${target.kind}`;
    apiFetch<{ url: string }>(path, { auth: false })
      .then((data) => { if (!disposed) setUrl(data?.url || ''); })
      .catch(() => { if (!disposed) setError('This photo is no longer available.'); });
    return () => { disposed = true; };
  }, [date, token, target]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const label = target.kind === 'checkout' ? 'Check-out photo' : 'Check-in photo';
  const time = target.kind === 'checkout' ? target.row.check_out : target.row.check_in;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/70 p-4" role="dialog" aria-modal="true" aria-label={`${label} of ${target.row.name}`}>
      <button type="button" aria-label="Close photo" tabIndex={-1} onClick={onClose} className="absolute inset-0 h-full w-full cursor-default" />
      <div className="relative w-full max-w-md overflow-hidden rounded-md bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-slate-800">{target.row.name}</p>
            <p className="text-xs text-slate-500">{label} · {time}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close photo" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="flex min-h-[16rem] items-center justify-center bg-slate-50 p-3">
          {error ? (
            <p className="text-sm text-slate-500">{error}</p>
          ) : url ? (
            <img src={url} alt={`${label} of ${target.row.name}`} className="max-h-[70svh] w-auto rounded object-contain" />
          ) : (
            <p className="text-sm text-slate-400">Loading photo…</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DailyReportPage({ date, token }: DailyReportPageProps) {
  const [report, setReport] = useState<DayReportResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [photo, setPhoto] = useState<PhotoTarget | null>(null);
  const [search, setSearch] = useState('');
  const [institute, setInstitute] = useState('');
  const [status, setStatus] = useState<DayStatus | ''>('');
  const toast = useToast();

  useEffect(() => {
    let disposed = false;
    let loaded = false;
    const path = `/api/v2/reports/daily/${encodeURIComponent(date)}/${encodeURIComponent(token)}`;
    const load = () => apiFetch<DayReportResponse>(path, { auth: false })
      .then((data) => {
        if (disposed) return;
        loaded = true;
        setReport(data);
        setError('');
      })
      .catch((requestError) => {
        if (disposed) return;
        const status = (requestError as { status?: number })?.status;
        if (status === 404) {
          setReport(null);
          setError('This report link is invalid or has expired.');
        } else if (!loaded) {
          setError('The report could not be loaded. Please try again.');
        }
      })
      .finally(() => { if (!disposed) setLoading(false); });
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [date, token]);

  if (loading) return <BrandedLoader label="Loading report" />;

  if (error || !report) {
    return (
      <main className="flex min-h-[100svh] items-center justify-center bg-[#f8f9fc] p-6">
        <div className="w-full max-w-md rounded-md border border-slate-200 bg-white p-8 text-center shadow-sm">
          <img src="/logo.png" alt="" className="mx-auto mb-4 h-12 w-12 object-contain" />
          <h1 className="text-lg font-extrabold text-slate-800">Report unavailable</h1>
          <p className="mt-2 text-sm text-slate-600">{error || 'The report could not be loaded.'}</p>
          <p className="mt-4 text-xs text-slate-400">Daily report links stop working 30 days after the day.</p>
        </div>
      </main>
    );
  }

  const count = report.rows.length;
  const rows = filterDayRows(report.rows, { search, institute, status });
  const institutes = dayInstitutes(report.rows);
  const filtered = Boolean(search.trim() || institute || status);
  const empty = count ? 'No instructors match these filters.' : `No check-ins on ${report.date_label}.`;

  const exportCsv = () => {
    saveCsvFile(dayReportFileName(report.date_label), dayReportCsv(rows)).catch((exportError) => {
      toast.error('Could not export the report', {
        detail: exportError instanceof Error ? exportError.message : String(exportError),
      });
    });
  };
  const FIELD = 'h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

  return (
    <main className="min-h-[100svh] bg-[#f8f9fc] px-4 py-8">
      <div className="mx-auto w-full max-w-7xl">
        <header className="mb-6 flex items-center gap-3">
          <img src="/logo.png" alt="" className="h-10 w-10 object-contain" />
          <div className="min-w-0">
            <p className="text-sm font-extrabold text-slate-800">FacultyTrack</p>
            <p className="text-[11px] font-medium uppercase tracking-widest text-slate-400">Daily report</p>
          </div>
        </header>

        <section className="mb-4">
          <h1 className="text-xl font-extrabold text-slate-800">Attendance &amp; Grooming Check</h1>
          <p className="mt-1 text-sm text-slate-500">
            {report.date_label} · Full day, {report.window_label} · {count} {count === 1 ? 'instructor' : 'instructors'}
            {filtered && ` · showing ${rows.length}`}
          </p>
        </section>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="relative min-w-0 flex-1 basis-full sm:basis-auto sm:flex-none">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search instructor name"
              placeholder="Search instructor name"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={`${FIELD} w-full pl-9 sm:w-64`}
            />
          </span>
          <select aria-label="Institute" value={institute} onChange={(event) => setInstitute(event.target.value)} className={`${FIELD} min-w-0 flex-1 sm:flex-none`}>
            <option value="">All institutes</option>
            {institutes.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value as DayStatus | '')} className={`${FIELD} min-w-0 flex-1 sm:flex-none`}>
            <option value="">All statuses</option>
            {DAY_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button
            type="button"
            onClick={exportCsv}
            disabled={rows.length === 0}
            title={rows.length ? `Download ${rows.length} rows as CSV` : 'Nothing to export'}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50 sm:ml-auto"
          >
            <Download size={16} aria-hidden="true" />
            Export CSV
          </button>
        </div>

        <ul className="flex flex-col gap-3 md:hidden">
          {rows.length === 0 ? (
            <li className="rounded-md border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">{empty}</li>
          ) : rows.map((row) => (
            <li key={row.attendance_id} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-slate-800">{row.name}</p>
                  {row.institute && <p className="truncate text-xs font-medium text-slate-500">{row.institute}</p>}
                </div>
                <span className="shrink-0 text-xs font-medium text-slate-400">{row.date}</span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-2 rounded bg-slate-50 px-3 py-2 text-xs">
                <div>
                  <dt className="font-bold uppercase tracking-wide text-slate-400">Check-in Time</dt>
                  <dd className="mt-0.5 font-semibold text-slate-700">{row.check_in}</dd>
                  <dd className="mt-1"><StatusPill status={row.status} /></dd>
                </div>
                <div>
                  <dt className="font-bold uppercase tracking-wide text-slate-400">Check-out Time</dt>
                  <dd className="mt-0.5 font-semibold text-slate-700">{row.check_out}</dd>
                </div>
              </dl>
              <p className="mt-2 text-sm text-slate-600">{row.feedback}</p>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Images</span>
                  <PhotoIcons row={row} onOpen={setPhoto} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Reports</span>
                  <ReportIcons row={row} />
                </div>
              </div>
            </li>
          ))}
        </ul>

        <div className="hidden overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm md:block">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th scope="col" className="border-b border-slate-200 p-3 whitespace-nowrap">Date</th>
                  <th scope="col" className="border-b border-slate-200 p-3">Instructor Name</th>
                  <th scope="col" className="border-b border-slate-200 p-3">Institute</th>
                  <th scope="col" className="border-b border-slate-200 p-3 whitespace-nowrap">Check-in Time</th>
                  <th scope="col" className="border-b border-slate-200 p-3 whitespace-nowrap">Check-out Time</th>
                  <th scope="col" className="border-b border-slate-200 p-3">Status</th>
                  <th scope="col" className="border-b border-slate-200 p-3">Feedback</th>
                  <th scope="col" className="border-b border-slate-200 p-3">Images</th>
                  <th scope="col" className="border-b border-slate-200 p-3">Reports</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 align-top">
                {rows.length === 0 ? (
                  <tr><td colSpan={9} className="p-8 text-center text-slate-400">{empty}</td></tr>
                ) : rows.map((row) => (
                  <tr key={row.attendance_id}>
                    <td className="p-3 whitespace-nowrap text-slate-600">{row.date}</td>
                    <td className="p-3 font-semibold text-slate-800">{row.name}</td>
                    <td className="p-3 text-slate-600">{row.institute || '-'}</td>
                    <td className="p-3 whitespace-nowrap text-slate-700">{row.check_in}</td>
                    <td className="p-3 whitespace-nowrap text-slate-700">{row.check_out}</td>
                    <td className="p-3"><StatusPill status={row.status} /></td>
                    <td className="p-3 text-slate-600">{row.feedback}</td>
                    <td className="p-3"><PhotoIcons row={row} onOpen={setPhoto} /></td>
                    <td className="p-3"><ReportIcons row={row} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="mt-3 text-xs text-slate-400">
          Images: <span className="text-indigo-600">check-in</span> and <span className="text-rose-600">check-out</span> photos.
          Reports: <span className="text-indigo-600">check-in</span> and <span className="text-rose-600">check-out</span> reports.
          {report.expires_at ? ` This link works until ${expiryLabel(report.expires_at)}.` : ''}
        </p>
      </div>

      {photo && <PhotoModal date={date} token={token} target={photo} onClose={() => setPhoto(null)} />}
    </main>
  );
}
