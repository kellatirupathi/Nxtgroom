import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChartColumnBig,
  Plus,
  TriangleAlert,
} from 'lucide-react';
import { apiFetch } from '../api';
import DateRangeFilter from './DateRangeFilter';
import InstituteFormDialog from './InstituteFormDialog';
import {
  isCompleteRange,
  localDateValue,
  rangeForPreset,
  type DatePreset,
  type DateRange,
} from '../attendanceFilters';
import {
  DASHBOARD_REFRESH_MS,
  formatCount,
  formatPercent,
  sortInstitutes,
  type InstituteSort,
  type InstituteSortKey,
} from '../dashboardFormat';
import type { DashboardInstitutesRange } from '../types';

const CARD = 'rounded-lg border border-slate-200 bg-white shadow-sm';
const INSTITUTE_HEADER_HEIGHT = 40;
const INSTITUTE_ROW_HEIGHT = 52;

const INSTITUTE_COLUMNS: { key: InstituteSortKey; label: string; numeric?: boolean }[] = [
  { key: 'name', label: 'Institute' },
  { key: 'present_percent', label: 'Present', numeric: true },
  { key: 'compliance_percent', label: 'Compliance', numeric: true },
  { key: 'non_compliant', label: 'Non-compliant', numeric: true },
  { key: 'enrolled_percent', label: 'Faces enrolled', numeric: true },
];

/**
 * Institutes: every institute side by side, for today or any range.
 *
 * Its own screen rather than a section of the Dashboard, so the Dashboard
 * stays a summary and the comparison has the whole page. Every range, today
 * included, comes from the same endpoint, and one that reaches today refreshes
 * itself every 30 seconds while the page is on screen, as the Dashboard does.
 */
export default function InstituteAnalytics() {
  const [sort, setSort] = useState<InstituteSort>({ key: 'present_percent', direction: 1 });
  const [preset, setPreset] = useState<DatePreset>('today');
  const [range, setRange] = useState<DateRange>(() => rangeForPreset('today', localDateValue()));
  const [result, setResult] = useState<DashboardInstitutesRange | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  // Bumped after an institute is added, so the table fetches again and shows
  // it; the rows on screen stay put while it does.
  const [reloadKey, setReloadKey] = useState(0);
  const hasResult = useRef(false);

  useEffect(() => {
    if (!isCompleteRange(range, preset)) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | null = null;
    const params = new URLSearchParams({ from: range.from, to: range.to });
    const path = `/api/v2/dashboard/institutes?${params.toString()}`;
    // A range that ends before today cannot change, so only one that reaches
    // today keeps refreshing.
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
    // Rows for the previous range must not stand in for the new one.
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
    // As tall as the screen allows, like Daily Records: the page itself does
    // not scroll, the table does, so every institute is reachable without the
    // heading or the date filter leaving the screen.
    <section className="mx-auto flex h-full min-h-0 w-full max-w-[1400px] flex-col gap-5" aria-labelledby="institutes-title">
      {/* The date filter sits at the right end of the heading row and never
          wraps below it; the note a longer range brings goes under the title. */}
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="institutes-title" className="flex items-center gap-2 text-lg font-bold text-slate-800 sm:text-xl">
            <ChartColumnBig size={22} className="text-indigo-600" aria-hidden="true" />
            Institutes
          </h2>
          {workingDays > 1 && (
            <p className="mt-1 text-xs text-slate-500">
              Present counts each instructor once per day they checked in, out of {formatCount(workingDays)} working days.
            </p>
          )}
        </div>
        {/* Add sits before the date filter, which stays at the far right.
            On a phone the button keeps only its icon so the row never wraps. */}
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

      <section className={`${CARD} flex min-h-0 flex-1 flex-col overflow-hidden`} aria-label="Institutes">
        {error && (
          <p role="alert" className="border-b border-rose-100 bg-rose-50 px-4 py-2 text-sm text-rose-700 md:px-5">
            {result ? `Showing the last figures. The latest refresh failed: ${error}` : error}
          </p>
        )}
        {!result ? (
          <p className="p-6 text-sm text-slate-400" aria-live="polite">
            {loading ? 'Loading institutes…' : error ? 'No figures to show.' : 'Choose a complete date range.'}
          </p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-slate-400">No institutes have been added yet.</p>
        ) : (
          // Fills the rest of the card and scrolls under a pinned header. A
          // floor keeps a few rows visible on a very short screen, where the
          // page then scrolls as well.
          <div
            className="min-h-[18rem] flex-1 overflow-auto overscroll-contain"
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
        )}
      </section>
    </section>
  );
}
