import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Building2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Download, ExternalLink, FileChartColumn } from 'lucide-react';
import { apiFetch } from '../api';
import { saveCsvFile } from '../attendanceExport';
import { dayReportApiPath, dayReportCsv, dayReportFileName, type DayReportResponse } from '../lib/dayReport';
import DailyReportSettings from './DailyReportSettings';
import { useToast } from './useToast';
import { currentIndiaMonth, monthLabel, shiftMonth } from '../lib/reportMonths';
import { readQueryParam, writeQueryParams } from '../routes';

const DAYS_PATH = '/api/v2/settings/daily-report/days';
const REFRESH_MS = 60_000;

export interface ReportDay {
  date: string;
  date_label: string;
  checkins: number;
  checkouts: number;
  not_checked_out: number;
  report_url: string | null;
}

export interface ReportCampus {
  college_id: string;
  institute: string;
  checkins: number;
  checkouts: number;
  not_checked_out: number;
  report_url: string | null;
}

interface CampusState {
  campuses?: ReportCampus[];
  error?: string;
}

const numberFormat = new Intl.NumberFormat('en-IN');

function campusesPath(date: string): string {
  return `${DAYS_PATH}/${encodeURIComponent(date)}/campuses`;
}

interface ReportLinkProps {
  url: string | null;
  label: string;
  onCopy: (url: string) => void;
  onExport: (url: string) => void;
  exporting: boolean;
}

function ReportLink({ url, label, onCopy, onExport, exporting }: ReportLinkProps) {
  if (!url) return <span className="text-slate-400">No check-ins</span>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 font-semibold text-blue-600 hover:text-blue-700 hover:underline"
      >
        <ExternalLink size={14} aria-hidden="true" />
        Open report
      </a>
      <button
        type="button"
        onClick={() => onCopy(url)}
        title="Copy link"
        aria-label={`Copy the report link for ${label}`}
        className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <Copy size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onExport(url)}
        disabled={exporting}
        title="Export as CSV"
        aria-label={`Export the report for ${label} as CSV`}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
      >
        <Download size={14} aria-hidden="true" />
        {exporting ? 'Exporting…' : 'Export'}
      </button>
    </div>
  );
}

function CampusToggle({ day, open, controls, onToggle }: { day: ReportDay; open: boolean; controls: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`${open ? 'Hide' : 'Show'} each campus's report for ${day.date_label}`}
      className="inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    >
      <Building2 size={14} aria-hidden="true" />
      Campuses
      {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
    </button>
  );
}

interface CampusListProps {
  state: CampusState | undefined;
  dateLabel: string;
  layout: 'cards' | 'table';
  onCopy: (url: string) => void;
  onExport: (url: string) => void;
  exportingUrl: string | null;
}

function CampusList({ state, dateLabel, layout, onCopy, onExport, exportingUrl }: CampusListProps) {
  if (state?.error) {
    return <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{state.error}</p>;
  }
  if (!state?.campuses) return <p className="p-3 text-sm text-slate-400">Loading campuses…</p>;
  if (!state.campuses.length) return <p className="p-3 text-sm text-slate-400">No campus had check-ins on {dateLabel}.</p>;

  const link = (campus: ReportCampus) => (
    <ReportLink
      url={campus.report_url}
      label={`${campus.institute} on ${dateLabel}`}
      onCopy={onCopy}
      onExport={onExport}
      exporting={exportingUrl === campus.report_url}
    />
  );

  if (layout === 'cards') {
    return (
      <ul className="flex flex-col gap-2" aria-label={`Campus reports for ${dateLabel}`}>
        {state.campuses.map((campus) => (
          <li key={campus.college_id} className="rounded-md border border-slate-200 bg-white p-3">
            <p className="flex items-start gap-1.5 text-sm font-bold text-slate-800">
              <Building2 size={15} className="mt-0.5 shrink-0 text-indigo-600" aria-hidden="true" />
              <span className="min-w-0">{campus.institute}</span>
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {campus.checkins} check-ins · {campus.checkouts} check-outs · <span className={campus.not_checked_out ? 'font-semibold text-amber-700' : ''}>{campus.not_checked_out} not checked out</span>
            </p>
            <div className="mt-2 text-sm">{link(campus)}</div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <table className="w-full border-collapse text-left text-sm" aria-label={`Campus reports for ${dateLabel}`}>
      <thead className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
        <tr>
          <th scope="col" className="border-b border-slate-200 px-3 py-2">Institute</th>
          <th scope="col" className="border-b border-slate-200 px-3 py-2">Check-ins</th>
          <th scope="col" className="border-b border-slate-200 px-3 py-2">Check-outs</th>
          <th scope="col" className="border-b border-slate-200 px-3 py-2">Not checked out</th>
          <th scope="col" className="border-b border-slate-200 px-3 py-2">Report</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {state.campuses.map((campus) => (
          <tr key={campus.college_id}>
            <td className="px-3 py-2 font-semibold text-slate-800">{campus.institute}</td>
            <td className="px-3 py-2 font-semibold">{campus.checkins}</td>
            <td className="px-3 py-2 font-semibold">{campus.checkouts}</td>
            <td className={`px-3 py-2 font-semibold ${campus.not_checked_out ? 'text-amber-700' : ''}`}>{campus.not_checked_out}</td>
            <td className="px-3 py-2">{link(campus)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ReportsTab() {
  const latestMonth = currentIndiaMonth();
  const [month, setMonth] = useState(() => {
    const requested = readQueryParam('month');
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) && requested <= latestMonth ? requested : latestMonth;
  });
  const [openDay, setOpenDay] = useState(() => {
    const requested = readQueryParam('campuses');
    return /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : '';
  });

  useEffect(() => {
    writeQueryParams({ month: month === latestMonth ? null : month, campuses: openDay || null });
  }, [month, latestMonth, openDay]);
  const [days, setDays] = useState<ReportDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [exportingUrl, setExportingUrl] = useState<string | null>(null);
  const [campusData, setCampusData] = useState<Record<string, CampusState>>({});
  const requestId = useRef(0);
  const toast = useToast();

  const load = useCallback(async (quiet: boolean) => {
    const id = ++requestId.current;
    if (!quiet) setLoading(true);
    try {
      const data = await apiFetch<{ month: string; days: ReportDay[] }>(`${DAYS_PATH}?month=${encodeURIComponent(month)}`);
      if (id !== requestId.current) return;
      setDays(Array.isArray(data?.days) ? data.days : []);
      setError('');
      setUpdatedAt(new Date());
    } catch (requestError) {
      if (id !== requestId.current) return;
      if ((requestError as { status?: number })?.status !== 401) {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void load(false);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  useEffect(() => {
    if (!openDay) return undefined;
    let disposed = false;
    setCampusData((current) => ({ ...current, [openDay]: { campuses: current[openDay]?.campuses } }));
    apiFetch<{ campuses: ReportCampus[] }>(campusesPath(openDay))
      .then((data) => {
        if (!disposed) setCampusData((current) => ({ ...current, [openDay]: { campuses: Array.isArray(data?.campuses) ? data.campuses : [] } }));
      })
      .catch((requestError) => {
        if (disposed || (requestError as { status?: number })?.status === 401) return;
        setCampusData((current) => ({
          ...current,
          [openDay]: { error: requestError instanceof Error ? requestError.message : 'The campus reports could not be loaded.' },
        }));
      });
    return () => { disposed = true; };
  }, [openDay]);

  const changeMonth = (next: string) => {
    setMonth(next);
    setOpenDay('');
  };

  const toggleDay = (date: string) => setOpenDay((current) => (current === date ? '' : date));

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Report link copied');
    } catch {
      toast.error('Could not copy the link', { detail: url });
    }
  };

  const exportReport = async (url: string) => {
    const path = dayReportApiPath(url);
    if (!path) return;
    setExportingUrl(url);
    try {
      const report = await apiFetch<DayReportResponse>(path, { auth: false });
      await saveCsvFile(dayReportFileName(report.date_label, report.institute), dayReportCsv(report.rows));
    } catch (exportError) {
      toast.error('Could not export the report', {
        detail: exportError instanceof Error ? exportError.message : String(exportError),
      });
    } finally {
      setExportingUrl(null);
    }
  };

  const onCopy = (url: string) => void copyLink(url);
  const onExport = (url: string) => void exportReport(url);

  const totals = days.reduce(
    (sum, day) => ({
      checkins: sum.checkins + day.checkins,
      checkouts: sum.checkouts + day.checkouts,
      notOut: sum.notOut + day.not_checked_out,
    }),
    { checkins: 0, checkouts: 0, notOut: 0 },
  );

  return (
    <section className="max-w-5xl" aria-labelledby="reports-title">
      <div className="mb-5">
        <h3 id="reports-title" className="text-lg font-extrabold text-slate-800 flex items-center gap-2">
          <FileChartColumn size={20} className="text-indigo-600" aria-hidden="true" />
          Reports
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          One row per day. Each day's report link opens its full report - every check-in and check-out,
          12:00 AM to 11:59 PM - and always shows the latest data. It is the same link that day's daily
          report emails carry, and works for 30 days.
        </p>
        <p className="mt-1 text-sm text-slate-500">
          Open Campuses on a day for each institute's own report, with its own link named after the institute.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => changeMonth(shiftMonth(month, -1))}
          aria-label="Previous month"
          className="rounded-md border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <input
          type="month"
          aria-label="Month"
          value={month}
          max={latestMonth}
          onChange={(event) => { if (event.target.value) changeMonth(event.target.value); }}
          className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
        />
        <button
          type="button"
          onClick={() => changeMonth(shiftMonth(month, 1))}
          disabled={month >= latestMonth}
          aria-label="Next month"
          className="rounded-md border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-40"
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        {updatedAt && (
          <span className="text-xs text-slate-400">
            Updated {updatedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}
          </span>
        )}
      </div>

      {!loading && !error && days.length > 0 && (
        <p className="mb-3 text-sm font-medium text-slate-600">
          {monthLabel(month)}: {numberFormat.format(totals.checkins)} check-ins · {numberFormat.format(totals.checkouts)} check-outs
          · {numberFormat.format(totals.notOut)} checked in but not checked out
        </p>
      )}

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>
      )}

      <ul className="flex flex-col gap-3 md:hidden">
        {loading ? (
          <li className="rounded-md border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">Loading reports…</li>
        ) : days.length === 0 ? (
          <li className="rounded-md border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">No days to show for {monthLabel(month)}.</li>
        ) : days.map((day) => (
          <li key={day.date} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="font-bold text-slate-800">{day.date_label}</p>
            <dl className="mt-2 grid grid-cols-3 gap-2 rounded bg-slate-50 px-3 py-2 text-xs">
              <div><dt className="font-bold uppercase tracking-wide text-slate-400">Check-ins</dt><dd className="mt-0.5 text-sm font-bold text-slate-800">{day.checkins}</dd></div>
              <div><dt className="font-bold uppercase tracking-wide text-slate-400">Check-outs</dt><dd className="mt-0.5 text-sm font-bold text-slate-800">{day.checkouts}</dd></div>
              <div><dt className="font-bold uppercase tracking-wide text-slate-400">Not checked out</dt><dd className="mt-0.5 text-sm font-bold text-amber-700">{day.not_checked_out}</dd></div>
            </dl>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <ReportLink url={day.report_url} label={day.date_label} onCopy={onCopy} onExport={onExport} exporting={exportingUrl === day.report_url} />
              {day.report_url && <CampusToggle day={day} open={openDay === day.date} controls={`campuses-card-${day.date}`} onToggle={() => toggleDay(day.date)} />}
            </div>
            {openDay === day.date && (
              <div id={`campuses-card-${day.date}`} className="mt-3 rounded-md bg-slate-50 p-2">
                <CampusList state={campusData[day.date]} dateLabel={day.date_label} layout="cards" onCopy={onCopy} onExport={onExport} exportingUrl={exportingUrl} />
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="hidden overflow-hidden rounded-md border border-slate-200 bg-white md:block">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-500">
            <tr>
              <th scope="col" className="border-b border-slate-200 p-3">Date</th>
              <th scope="col" className="border-b border-slate-200 p-3">Check-ins</th>
              <th scope="col" className="border-b border-slate-200 p-3">Check-outs</th>
              <th scope="col" className="border-b border-slate-200 p-3">Checked in, not checked out</th>
              <th scope="col" className="border-b border-slate-200 p-3">Report</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={5} className="p-8 text-center text-slate-400">Loading reports…</td></tr>
            ) : days.length === 0 ? (
              <tr><td colSpan={5} className="p-8 text-center text-slate-400">No days to show for {monthLabel(month)}.</td></tr>
            ) : days.map((day) => (
              <Fragment key={day.date}>
                <tr className={day.checkins ? undefined : 'text-slate-400'}>
                  <td className="p-3 font-semibold text-slate-800 whitespace-nowrap">{day.date_label}</td>
                  <td className="p-3 font-semibold">{day.checkins}</td>
                  <td className="p-3 font-semibold">{day.checkouts}</td>
                  <td className={`p-3 font-semibold ${day.not_checked_out ? 'text-amber-700' : ''}`}>{day.not_checked_out}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <ReportLink url={day.report_url} label={day.date_label} onCopy={onCopy} onExport={onExport} exporting={exportingUrl === day.report_url} />
                      {day.report_url && <CampusToggle day={day} open={openDay === day.date} controls={`campuses-row-${day.date}`} onToggle={() => toggleDay(day.date)} />}
                    </div>
                  </td>
                </tr>
                {openDay === day.date && (
                  <tr id={`campuses-row-${day.date}`}>
                    <td colSpan={5} className="bg-slate-50/70 px-4 pb-4 pt-2">
                      <div className="rounded-md border border-slate-200 bg-white">
                        <CampusList state={campusData[day.date]} dateLabel={day.date_label} layout="table" onCopy={onCopy} onExport={onExport} exportingUrl={exportingUrl} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <DailyReportSettings />
    </section>
  );
}
