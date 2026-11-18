import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChartColumnBig,
  ChevronLeft,
  Plus,
  TriangleAlert,
} from 'lucide-react';
import { apiFetch } from '../api';
import DateRangeFilter from './DateRangeFilter';
import InstituteFormDialog from './InstituteFormDialog';
import {
  datePresetFromQuery,
  datePresetToQuery,
  isCompleteRange,
  localDateValue,
  type DatePreset,
  type DateRange,
} from '../attendanceFilters';
import {
  DASHBOARD_REFRESH_MS,
  formatCount,
  formatPercent,
  instituteSortFromQuery,
  instituteSortToQuery,
  sortInstitutes,
  type InstituteSort,
  type InstituteSortKey,
} from '../dashboardFormat';
import type { DashboardInstitutesRange } from '../types';
import { useLocation } from '../lib/useLocation';
import { closeChildPath, currentPathWith, goToPath, openChildPath, pathForTab, TABS, writeQueryParams } from '../routes';

const INSTITUTE_HEADER_HEIGHT = 40;
const INSTITUTE_ROW_HEIGHT = 52;

const INSTITUTE_COLUMNS: { key: InstituteSortKey; label: string; numeric?: boolean }[] = [
  { key: 'name', label: 'Institute' },
  { key: 'present_percent', label: 'Present', numeric: true },
  { key: 'compliance_percent', label: 'Compliance', numeric: true },
  { key: 'non_compliant', label: 'Non-compliant', numeric: true },
  { key: 'enrolled_percent', label: 'Faces enrolled', numeric: true },
];

const MOBILE_SORTS: { value: string; label: string; sort: InstituteSort }[] = [
  { value: 'compliance_asc', label: 'Lowest compliance', sort: { key: 'compliance_percent', direction: 1 } },
  { value: 'non_compliant_desc', label: 'Most non-compliant', sort: { key: 'non_compliant', direction: -1 } },
  { value: 'present_asc', label: 'Lowest attendance', sort: { key: 'present_percent', direction: 1 } },
  { value: 'enrolled_asc', label: 'Fewest faces enrolled', sort: { key: 'enrolled_percent', direction: 1 } },
  { value: 'name_asc', label: 'Name A–Z', sort: { key: 'name', direction: 1 } },
];

function mobileSortValue(sort: InstituteSort): string {
  return MOBILE_SORTS.find((option) => option.sort.key === sort.key && option.sort.direction === sort.direction)?.value || '';
}

function needsAttention(row: { compliance_percent: number | null; low_enrolment: boolean }): boolean {
  return (typeof row.compliance_percent === 'number' && row.compliance_percent < 80) || row.low_enrolment;
}

export default function InstituteAnalytics() {
  const [initial] = useState(() => datePresetFromQuery(window.location.search, localDateValue()));
  const [sort, setSort] = useState<InstituteSort>(() => instituteSortFromQuery(window.location.search));
  const [preset, setPreset] = useState<DatePreset>(initial.preset);
  const [range, setRange] = useState<DateRange>(initial.range);
  const [result, setResult] = useState<DashboardInstitutesRange | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { pathname } = useLocation();
  const adding = pathname.replace(/\/+$/, '') === '/institutes/new';
  const setAdding = (open: boolean) => {
    if (open) openChildPath(currentPathWith({}).replace(/^\/institutes(?=[?#]|$)/, '/institutes/new'));
    else closeChildPath(currentPathWith({}).replace(/^\/institutes\/new(?=[?#]|$)/, '/institutes'));
  };
  const [reloadKey, setReloadKey] = useState(0);
  const hasResult = useRef(false);

  useEffect(() => {
    if (adding) return;
    writeQueryParams({ ...datePresetToQuery(preset, range), ...instituteSortToQuery(sort) });
  }, [preset, range, sort, adding]);

  useEffect(() => {
    if (!isCompleteRange(range, preset)) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | null = null;
    const params = new URLSearchParams({ from: range.from, to: range.to });
    const path = `/api/v2/dashboard/institutes?${params.toString()}`;
    const live = !range.to || range.to >= localDateValue();

    const schedule = () => {
      clearTimeout(timer);
      if (live && !disposed && document.visibilityState === 'visible') {
        timer = setTimeout(() => { void run(); }, DASHBOARD_REFRESH_MS);
      }
    };

    const run = async () => {
      if (disposed || active) return;
      if (document.visibilityState !== 'visible') {
        setLoading(false);
        return;
      }
      const controller = new AbortController();
      active = controller;
      if (!hasResult.current) setLoading(true);
      try {
        const next = await apiFetch<DashboardInstitutesRange>(path, { signal: controller.signal });
        if (!disposed) {
          hasResult.current = true;
          setResult(next);
          setError('');
        }
      } catch (requestError) {
        if (!disposed && !controller.signal.aborted && (requestError as { status?: number })?.status !== 401) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      } finally {
        if (!disposed) setLoading(false);
        active = null;
        schedule();
      }
    };

    const handleVisibilityChange = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') active?.abort();
      else if (!active) void run();
    };

    void run();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      clearTimeout(timer);
      active?.abort();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [preset, range, reloadKey]);

  const changeRange = (nextPreset: DatePreset, nextRange: DateRange) => {
    hasResult.current = false;
    setResult(null);
    setError('');
    setPreset(nextPreset);
    setRange(nextRange);
  };

  const workingDays = result?.working_days ?? 0;
  const rows = useMemo(() => sortInstitutes(result?.institutes ?? [], sort), [result, sort]);
  const toggle = (key: InstituteSortKey) => {
    setSort((current) => (
      current.key === key
        ? { key, direction: current.direction === 1 ? -1 : 1 }
        : { key, direction: key === 'name' || key === 'present_percent' || key === 'compliance_percent' || key === 'enrolled_percent' ? 1 : -1 }
    ));
  };

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-[1400px] flex-col gap-3 md:gap-5" aria-labelledby="institutes-title">
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-1">
          <button
            type="button"
            onClick={() => goToPath(pathForTab(TABS.MORE))}
            aria-label="Back to More"
            className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-900 hover:bg-slate-100 lg:hidden"
          >
            <ChevronLeft size={22} aria-hidden="true" />
          </button>
          <div className="min-w-0 pt-2 lg:pt-0">
          <h2 id="institutes-title" className="flex items-center gap-2 text-xl font-extrabold text-slate-900 lg:text-xl lg:font-bold lg:text-slate-800">
            <ChartColumnBig size={22} className="hidden text-indigo-600 lg:block" aria-hidden="true" />
            Institutes
          </h2>
          {workingDays > 1 && (
            <p className="mt-1 text-xs text-slate-500">
              Present counts each instructor once per day they checked in, out of {formatCount(workingDays)} working days.
            </p>
          )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setAdding(true)}
            aria-label="Add institute"
            title="Add institute"
            className="flex h-9 items-center gap-1.5 rounded-md bg-indigo-600 px-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 sm:px-3"
          >
            <Plus size={16} strokeWidth={2.5} aria-hidden="true" />
            <span className="hidden sm:inline">Add Institute</span>
          </button>
          <DateRangeFilter preset={preset} range={range} today={localDateValue()} onChange={changeRange} />
        </div>
      </div>

      <InstituteFormDialog
        open={adding}
        college={null}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          setReloadKey((key) => key + 1);
        }}
      />

      <label className="flex h-11 shrink-0 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 md:hidden">
        <ArrowUpDown size={16} className="text-slate-500" aria-hidden="true" />
        <span className="sr-only">Sort institutes</span>
        <select
          value={mobileSortValue(sort)}
          onChange={(event) => {
            const choice = MOBILE_SORTS.find((option) => option.value === event.target.value);
            if (choice) setSort(choice.sort);
          }}
          className="h-full flex-1 bg-transparent text-sm font-semibold text-slate-900 outline-none"
        >
          {!mobileSortValue(sort) && <option value="">Sorted by column</option>}
          {MOBILE_SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>

      <section className="flex min-h-0 flex-col md:flex-1 md:overflow-hidden md:rounded-lg md:border md:border-slate-200 md:bg-white md:shadow-sm" aria-label="Institutes">
        {error && (
          <p role="alert" className="border-b border-rose-100 bg-rose-50 px-4 py-2 text-sm text-rose-700 max-md:mb-2 max-md:rounded-xl max-md:border md:px-5">
            {result ? `Showing the last figures. The latest refresh failed: ${error}` : error}
          </p>
        )}
        {!result ? (
          <p className="p-6 text-sm text-slate-400 max-md:rounded-2xl max-md:border max-md:border-slate-200 max-md:bg-white max-md:text-slate-500" aria-live="polite">
            {loading ? 'Loading institutes…' : error ? 'No figures to show.' : 'Choose a complete date range.'}
          </p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-slate-400 max-md:rounded-2xl max-md:border max-md:border-slate-200 max-md:bg-white max-md:text-slate-500">No institutes have been added yet.</p>
        ) : (
          <>
          <ul className="flex flex-col gap-2.5 pb-2 md:hidden" aria-label="Institute figures">
            {rows.map((row) => {
              const flagged = needsAttention(row);
              return (
                <li key={row.college_id} className={`rounded-2xl border bg-white px-4 py-3.5 ${flagged ? 'border-rose-200' : 'border-slate-200'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 text-base font-bold text-slate-900">{row.name}</p>
                    {flagged && (
                      <span className="shrink-0 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-xs font-bold text-rose-700">Needs attention</span>
                    )}
                  </div>
                  <p className="mt-2.5 flex justify-between text-xs font-semibold text-slate-500">
                    <span>Present</span>
                    <span className="text-slate-900 tabular-nums">{formatPercent(row.present_percent)} <span className="font-medium text-slate-500">· {formatCount(row.present)} / {formatCount(row.expected)}</span></span>
                  </p>
                  <span className="mt-1.5 block h-2 rounded-full bg-slate-100" aria-hidden="true">
                    <span className="block h-2 rounded-full bg-indigo-600" style={{ width: `${Math.min(100, row.present_percent ?? 0)}%` }} />
                  </span>
                  <p className="mt-2.5 flex justify-between text-xs font-semibold text-slate-500">
                    <span>Compliance</span>
                    <span className={`tabular-nums ${typeof row.compliance_percent === 'number' && row.compliance_percent < 80 ? 'text-rose-700' : 'text-slate-900'}`}>{formatPercent(row.compliance_percent)}</span>
                  </p>
                  <span className="mt-1.5 block h-2 rounded-full bg-slate-100" aria-hidden="true">
                    <span className="block h-2 rounded-full bg-cyan-600" style={{ width: `${Math.min(100, row.compliance_percent ?? 0)}%` }} />
                  </span>
                  <p className="mt-3 flex gap-3.5 border-t border-slate-100 pt-2.5 text-xs text-slate-500">
                    <span><b className="text-rose-700 tabular-nums">{formatCount(row.non_compliant)}</b> non-compliant</span>
                    <span>
                      <b className={`tabular-nums ${row.low_enrolment ? 'text-amber-700' : 'text-slate-900'}`}>{row.enrolled_percent}%</b> faces enrolled
                    </span>
                  </p>
                </li>
              );
            })}
          </ul>
          <div
            className="hidden min-h-[18rem] flex-1 overflow-auto overscroll-contain md:block"
            tabIndex={0}
            aria-label="Institutes, scrollable"
          >
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr style={{ height: INSTITUTE_HEADER_HEIGHT }}>
                  {INSTITUTE_COLUMNS.map((column) => {
                    const active = sort.key === column.key;
                    const SortIcon = active ? (sort.direction === 1 ? ArrowUp : ArrowDown) : ArrowUpDown;
                    return (
                      <th
                        key={column.key}
                        scope="col"
                        aria-sort={active ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none'}
                        className={`sticky top-0 z-10 bg-slate-50 px-3 text-xs first:pl-4 last:pr-4 font-bold uppercase tracking-wider text-slate-500 shadow-[inset_0_-1px_0_0_rgb(226_232_240)] ${column.numeric ? 'text-right' : ''}`}
                      >
                        <button
                          type="button"
                          onClick={() => toggle(column.key)}
                          className={`inline-flex items-center gap-1 whitespace-nowrap uppercase tracking-wider rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${active ? 'text-indigo-700' : 'hover:text-slate-700'}`}
                        >
                          {column.label}
                          <SortIcon size={12} aria-hidden="true" />
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const cell = `px-3 first:pl-4 last:pr-4 whitespace-nowrap ${index === 0 ? '' : 'shadow-[inset_0_1px_0_0_rgb(241_245_249)]'}`;
                  return (
                    <tr key={row.college_id} style={{ height: INSTITUTE_ROW_HEIGHT }} className="hover:bg-slate-50">
                      <td className={`${cell} max-w-[240px] truncate font-semibold text-slate-800`} title={row.name}>{row.name}</td>
                      <td className={`${cell} text-right tabular-nums`}>
                        <span className="inline-flex items-center gap-2">
                          <span aria-hidden="true" className="hidden h-1.5 w-12 rounded-full bg-slate-100 md:block">
                            <span className="block h-1.5 rounded-full bg-indigo-600" style={{ width: `${Math.min(100, row.present_percent ?? 0)}%` }} />
                          </span>
                          <span className="font-semibold text-slate-800">{formatCount(row.present)}</span>
                          <span className="text-slate-400">/ {formatCount(row.expected)}</span>
                        </span>
                      </td>
                      <td className={`${cell} text-right font-semibold tabular-nums ${typeof row.compliance_percent === 'number' && row.compliance_percent < 80 ? 'text-rose-600' : 'text-slate-800'}`}>
                        {formatPercent(row.compliance_percent)}
                      </td>
                      <td className={`${cell} text-right tabular-nums text-slate-700`}>{formatCount(row.non_compliant)}</td>
                      <td className={`${cell} text-right tabular-nums`}>
                        {row.low_enrolment ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-700"
                            title={`${formatCount(row.enrolled)} of ${formatCount(row.instructors)} instructors enrolled`}
                          >
                            <TriangleAlert size={12} aria-hidden="true" />{row.enrolled_percent}% · Low
                          </span>
                        ) : (
                          <span className="font-semibold text-slate-700" title={`${formatCount(row.enrolled)} of ${formatCount(row.instructors)} instructors enrolled`}>
                            {row.enrolled_percent}%
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </section>
    </section>
  );
}
