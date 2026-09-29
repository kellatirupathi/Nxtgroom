import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Building2,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  LayoutDashboard,
  List,
  LogOut,
  Minus,
  ScanFace,
  ShieldAlert,
  Shirt,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  UserCheck,
  UserRoundSearch,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { apiFetch } from '../api';
import BrandedLoader from './BrandedLoader';
import DateRangeFilter from './DateRangeFilter';
import { isCompleteRange, rangeForPreset, type DatePreset, type DateRange } from '../attendanceFilters';
import {
  complianceChange,
  DASHBOARD_REFRESH_MS,
  formatCount,
  formatPercent,
  formatWait,
  INSTITUTE_VISIBLE_ROWS,
  shortDayLabel,
  sortInstitutes,
  tooltipDayLabel,
  updatedAtLabel,
  weekdayLabel,
  type InstituteSort,
  type InstituteSortKey,
} from '../dashboardFormat';
import type {
  DashboardData,
  DashboardInstitutesRange,
  DashboardStatusKey,
  DashboardTrendDay,
} from '../types';

interface DashboardProps {
  /** Moves to another screen, e.g. Daily Records or the Unidentified queue. */
  onNavigate: (tab: string) => void;
  /** Whether this account may open the Unidentified queue. */
  canIdentify?: boolean;
}

// Chart colours. Checked for colour-blind separation between neighbours; every
// mark is also labelled, so colour never carries meaning on its own.
const COLOR_ATTENDANCE = '#4f46e5';
const COLOR_COMPLIANCE = '#0891b2';
const TEXT_MUTED = '#94a3b8';
const TEXT_STRONG = '#1e293b';
const GRID = '#eef2f7';
const AXIS = '#cbd5e1';

const STATUS_META: Record<DashboardStatusKey, { label: string; color: string; badge: string; icon: LucideIcon }> = {
  compliant: { label: 'Compliant', color: '#059669', badge: 'bg-emerald-50 text-emerald-600 border-emerald-200', icon: CircleCheck },
  unassessed: { label: 'Not assessed', color: '#f59e0b', badge: 'bg-amber-50 text-amber-700 border-amber-200', icon: CircleAlert },
  non_compliant: { label: 'Non-compliant', color: '#e11d48', badge: 'bg-rose-50 text-rose-600 border-rose-200', icon: CircleX },
  pending: { label: 'Pending AI', color: '#6366f1', badge: 'bg-amber-50 text-amber-600 border-amber-200', icon: Clock },
  error: { label: 'Analysis error', color: '#94a3b8', badge: 'bg-slate-100 text-slate-600 border-slate-200', icon: TriangleAlert },
};

const CARD = 'rounded-lg border border-slate-200 bg-white shadow-sm';
const TREND_RANGES = [7, 14, 30] as const;
const INSTITUTE_HEADER_HEIGHT = 40;
const INSTITUTE_ROW_HEIGHT = 52;

/** Tracks an element's rendered width so a chart can draw at its real size. */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const update = () => setWidth(node.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function ChartTooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  // Kept inside the chart: centred on the point, clamped to the chart's edges.
  const half = 90;
  const left = Math.max(half, Math.min(width - half, x));
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-slate-900 px-2.5 py-2 text-xs leading-relaxed text-slate-50 shadow-lg"
      style={{ left, top: y - 10 }}
    >
      {children}
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return <span aria-hidden="true" className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: color }} />;
}

function KpiTile({
  label,
  icon: Icon,
  iconClass,
  tone = 'default',
  children,
}: {
  label: string;
  icon: LucideIcon;
  iconClass: string;
  tone?: 'default' | 'alert';
  children: ReactNode;
}) {
  const frame = tone === 'alert' ? 'border-rose-200 bg-rose-50/60' : 'border-slate-200 bg-white';
  return (
    <div className={`rounded-lg border p-4 shadow-sm ${frame}`}>
      <div className={`flex items-center justify-between gap-2 text-xs font-bold uppercase tracking-wider ${tone === 'alert' ? 'text-rose-700' : 'text-slate-500'}`}>
        {label}
        <Icon size={16} aria-hidden="true" className={iconClass} />
      </div>
      {children}
    </div>
  );
}

function TileLink({ onClick, children, tone = 'indigo' }: { onClick: () => void; children: ReactNode; tone?: 'indigo' | 'rose' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mt-1 inline-flex items-center gap-1 text-xs font-semibold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded ${tone === 'rose' ? 'text-rose-700' : 'text-indigo-700'}`}
    >
      {children}
      <ArrowRight size={12} aria-hidden="true" />
    </button>
  );
}

function TrendChart({ trend }: { trend: DashboardTrendDay[] }) {
  const [days, setDays] = useState<(typeof TREND_RANGES)[number]>(14);
  const [hover, setHover] = useState<number | null>(null);
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const data = trend.slice(-days);
  const height = 256;
  const margin = { top: 12, right: 52, bottom: 26, left: 40 };
  const innerWidth = Math.max(0, width - margin.left - margin.right);
  const innerHeight = height - margin.top - margin.bottom;

  const values = data.flatMap((row) => [row.present_percent, row.compliance_percent])
    .filter((value): value is number => typeof value === 'number');
  const lowest = values.length ? Math.min(...values) : 60;
  const yMin = Math.max(0, Math.min(60, Math.floor((lowest - 5) / 10) * 10));
  const yStep = 100 - yMin > 50 ? 20 : 10;
  const ticks: number[] = [];
  for (let value = yMin; value <= 100; value += yStep) ticks.push(value);

  const x = (index: number) => margin.left + (data.length <= 1 ? innerWidth / 2 : (index / (data.length - 1)) * innerWidth);
  const y = (value: number) => margin.top + (1 - (value - yMin) / (100 - yMin)) * innerHeight;

  const series = [
    { key: 'present_percent' as const, label: 'Present', color: COLOR_ATTENDANCE },
    { key: 'compliance_percent' as const, label: 'Compliant', color: COLOR_COMPLIANCE },
  ];

  /** A line broken wherever a day has no value, rather than drawn through it. */
  const linePath = (key: 'present_percent' | 'compliance_percent') => {
    let path = '';
    let drawing = false;
    data.forEach((row, index) => {
      const value = row[key];
      if (typeof value !== 'number') {
        drawing = false;
        return;
      }
      path += `${drawing ? 'L' : 'M'}${x(index)},${y(value)}`;
      drawing = true;
    });
    return path;
  };

  const lastIndex = data.length - 1;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerWidth / 72))));
  const hovered = hover !== null ? data[hover] : null;

  const pointAt = (clientX: number, target: SVGRectElement) => {
    const box = target.getBoundingClientRect();
    const ratio = box.width ? (clientX - box.left) / box.width : 0;
    setHover(Math.max(0, Math.min(lastIndex, Math.round(ratio * lastIndex))));
  };

  return (
    <section className={`${CARD} p-4 md:p-5 xl:col-span-2`} aria-labelledby="dashboard-trend-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="dashboard-trend-title" className="text-base font-bold text-slate-800">Attendance and compliance</h3>
          <p className="text-xs text-slate-500">Share of instructors present, and share of analysed check-ins that passed, per working day (Mon–Sat)</p>
        </div>
        <div className="inline-flex rounded-md bg-slate-100 p-0.5" role="group" aria-label="Date range">
          {TREND_RANGES.map((range) => (
            <button
              key={range}
              type="button"
              aria-pressed={days === range}
              onClick={() => { setDays(range); setHover(null); }}
              className={`rounded px-3 py-1 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                days === range ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600 hover:text-slate-800'
              }`}
            >
              {range} days
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs font-medium text-slate-600">
        {series.map((item) => (
          <span key={item.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-0.5 w-4 rounded" style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
      <div ref={ref} className="relative mt-2 w-full" style={{ height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`Present and compliant percentage over the last ${days} working days`}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} stroke={tick === yMin ? AXIS : GRID} />
                <text x={margin.left - 8} y={y(tick) + 4} textAnchor="end" fontSize={11} fill={TEXT_MUTED}>{tick}%</text>
              </g>
            ))}
            {data.map((row, index) => {
              const show = index === lastIndex || (index % labelEvery === 0 && lastIndex - index >= labelEvery * 0.6);
              if (!show) return null;
              return (
                <text key={row.day} x={x(index)} y={height - 6} textAnchor="middle" fontSize={11} fill={TEXT_MUTED}>
                  {index === lastIndex ? 'Today' : shortDayLabel(row.day)}
                </text>
              );
            })}
            {series.map((item) => (
              <path
                key={item.key}
                d={linePath(item.key)}
                fill="none"
                stroke={item.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {series.map((item) => {
              const value = data[lastIndex]?.[item.key];
              if (typeof value !== 'number') return null;
              return (
                <g key={item.key}>
                  <circle cx={x(lastIndex)} cy={y(value)} r={4} fill={item.color} stroke="#fff" strokeWidth={2} />
                  <text x={x(lastIndex) + 8} y={y(value) + 4} fontSize={11} fontWeight={700} fill={TEXT_STRONG}>
                    {value.toFixed(1)}%
                  </text>
                </g>
              );
            })}
            {hovered && hover !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={margin.top} y2={margin.top + innerHeight} stroke={AXIS} />
                {series.map((item) => {
                  const value = hovered[item.key];
                  return typeof value === 'number'
                    ? <circle key={item.key} cx={x(hover)} cy={y(value)} r={4} fill={item.color} stroke="#fff" strokeWidth={2} />
                    : null;
                })}
              </g>
            )}
            <rect
              x={margin.left}
              y={margin.top}
              width={innerWidth}
              height={innerHeight}
              fill="transparent"
              onPointerMove={(event) => pointAt(event.clientX, event.currentTarget)}
              onPointerDown={(event) => pointAt(event.clientX, event.currentTarget)}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        )}
        {hovered && hover !== null && (
          <ChartTooltip
            x={x(hover)}
            y={Math.min(
              ...series.map((item) => {
                const value = hovered[item.key];
                return typeof value === 'number' ? y(value) : margin.top + innerHeight;
              }),
            )}
            width={width}
          >
            <div className="font-bold">{tooltipDayLabel(hovered.day)}</div>
            <div><Swatch color={COLOR_ATTENDANCE} />Present <b>{formatPercent(hovered.present_percent)}</b> ({formatCount(hovered.present)})</div>
            <div><Swatch color={COLOR_COMPLIANCE} />Compliant <b>{formatPercent(hovered.compliance_percent)}</b> ({formatCount(hovered.compliant)} of {formatCount(hovered.compliant + hovered.non_compliant)})</div>
          </ChartTooltip>
        )}
      </div>
    </section>
  );
}

function StatusCard({ data }: { data: DashboardData }) {
  const [hover, setHover] = useState<DashboardStatusKey | null>(null);
  const total = data.status_breakdown.reduce((sum, row) => sum + row.count, 0);
  const segments = data.status_breakdown.filter((row) => row.count > 0);
  const hovered = hover ? data.status_breakdown.find((row) => row.key === hover) : null;
  return (
    <section className={`${CARD} p-4 md:p-5`} aria-labelledby="dashboard-status-title">
      <h3 id="dashboard-status-title" className="text-base font-bold text-slate-800">Today&apos;s check-ins by result</h3>
      <p className="text-xs text-slate-500 tabular-nums">{formatCount(total)} check-in{total === 1 ? '' : 's'} recorded</p>
      <div className="relative mt-4">
        {total > 0 ? (
          <div className="flex h-3 w-full gap-[2px]" role="img" aria-label="Check-in results today">
            {segments.map((row, index) => (
              <div
                key={row.key}
                onPointerEnter={() => setHover(row.key)}
                onPointerLeave={() => setHover(null)}
                className={`${index === 0 ? 'rounded-l' : ''} ${index === segments.length - 1 ? 'rounded-r' : ''}`}
                style={{ flex: `${row.count} 1 0`, minWidth: 3, background: STATUS_META[row.key].color }}
              />
            ))}
          </div>
        ) : (
          <div className="h-3 w-full rounded bg-slate-100" aria-hidden="true" />
        )}
        {hovered && (
          <div className="pointer-events-none absolute -top-2 left-1/2 z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-slate-900 px-2.5 py-1.5 text-xs text-slate-50 shadow-lg">
            <Swatch color={STATUS_META[hovered.key].color} />{STATUS_META[hovered.key].label} <b>{formatCount(hovered.count)}</b> ({formatPercent(total ? (hovered.count / total) * 100 : null)})
          </div>
        )}
      </div>
      <ul className="mt-4 divide-y divide-slate-100">
        {data.status_breakdown.map((row) => {
          const meta = STATUS_META[row.key];
          const Icon = meta.icon;
          return (
            <li key={row.key} className="flex items-center justify-between gap-3 py-2.5">
              <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-bold ${meta.badge}`}>
                <Icon size={12} aria-hidden="true" />{meta.label}
              </span>
              <span className="flex items-center gap-2 text-sm tabular-nums">
                <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: meta.color }} />
                <b className="text-slate-800">{formatCount(row.count)}</b>
                <span className="w-14 text-right text-slate-400">{total ? formatPercent((row.count / total) * 100) : '—'}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function FailedCheckpoints({ data }: { data: DashboardData }) {
  const rows = data.failed_checkpoints;
  const max = rows[0]?.count || 1;
  return (
    <section className={`${CARD} p-4 md:p-5`} aria-labelledby="dashboard-fails-title">
      <h3 id="dashboard-fails-title" className="text-base font-bold text-slate-800">Most failed checkpoints</h3>
      <p className="text-xs text-slate-500">Failed checks this week (from {shortDayLabel(data.week_start)}), check-in and check-out</p>
      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-slate-400">No failed checkpoints this week.</p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {rows.map((row) => (
            <li key={row.code} className="grid grid-cols-[minmax(0,11rem)_1fr_2.75rem] items-center gap-3 text-sm sm:grid-cols-[minmax(0,15rem)_1fr_2.75rem]">
              <span className="min-w-0 truncate text-slate-700" title={`${row.name} · ${row.audience}`}>
                {row.name} <span className="text-xs text-slate-400">· {row.audience}</span>
              </span>
              <span className="h-2.5 rounded-full bg-slate-100" aria-hidden="true">
                <span className="block h-2.5 rounded-full bg-rose-500" style={{ width: `${(row.count / max) * 100}%` }} />
              </span>
              <b className="text-right tabular-nums text-slate-800">{formatCount(row.count)}</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const INSTITUTE_COLUMNS: { key: InstituteSortKey; label: string; numeric?: boolean }[] = [
  { key: 'name', label: 'Institute' },
  { key: 'mode', label: 'Mode' },
  { key: 'present_percent', label: 'Present', numeric: true },
  { key: 'compliance_percent', label: 'Compliance', numeric: true },
  { key: 'non_compliant', label: 'Non-compliant', numeric: true },
  { key: 'unidentified', label: 'Unidentified', numeric: true },
  { key: 'enrolled_percent', label: 'Faces enrolled', numeric: true },
];

function InstitutesTable({ data }: { data: DashboardData }) {
  const [sort, setSort] = useState<InstituteSort>({ key: 'present_percent', direction: 1 });
  const [preset, setPreset] = useState<DatePreset>('today');
  const [range, setRange] = useState<DateRange>(() => rangeForPreset('today', data.today));
  const [ranged, setRanged] = useState<DashboardInstitutesRange | null>(null);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [rangeError, setRangeError] = useState('');

  // Today's table arrives with the Dashboard and refreshes with it. Any other
  // range is fetched on its own; one that reaches today is fetched again each
  // time the page refreshes, so it stays as current as the rest of the page.
  const showingToday = preset === 'today';
  const reachesToday = !range.to || range.to >= data.today;
  const refreshKey = !showingToday && reachesToday ? data.generated_at : '';
  useEffect(() => {
    if (showingToday || !isCompleteRange(range, preset)) return undefined;
    const controller = new AbortController();
    const params = new URLSearchParams({ from: range.from, to: range.to });
    setRangeLoading(true);
    apiFetch<DashboardInstitutesRange>(`/api/v2/dashboard/institutes?${params.toString()}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setRanged(result);
        setRangeError('');
      })
      .catch((requestError) => {
        if (controller.signal.aborted || (requestError as { status?: number })?.status === 401) return;
        setRangeError(requestError instanceof Error ? requestError.message : String(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setRangeLoading(false);
      });
    return () => controller.abort();
  }, [showingToday, preset, range, refreshKey]);

  const changeRange = (nextPreset: DatePreset, nextRange: DateRange) => {
    setPreset(nextPreset);
    setRange(nextRange);
    // Rows for the previous range must not stand in for the new one.
    setRanged(null);
    setRangeError('');
  };

  const workingDays = showingToday ? 1 : ranged?.working_days ?? 0;
  const waiting = !showingToday && !ranged && (rangeLoading || !rangeError);
  const rows = useMemo(
    () => sortInstitutes(showingToday ? data.institutes : ranged?.institutes ?? [], sort),
    [showingToday, data.institutes, ranged, sort],
  );
  const toggle = (key: InstituteSortKey) => {
    setSort((current) => (
      current.key === key
        ? { key, direction: current.direction === 1 ? -1 : 1 }
        : { key, direction: key === 'name' || key === 'mode' || key === 'present_percent' || key === 'compliance_percent' || key === 'enrolled_percent' ? 1 : -1 }
    ));
  };
  const scrolls = rows.length > INSTITUTE_VISIBLE_ROWS;

  return (
    <section className={CARD} aria-labelledby="dashboard-institutes-title">
      {/* No wrapping: the filter holds the top-right corner whatever range is
          chosen, and the longer description a range brings wraps under the
          title instead of pushing the filter onto a line of its own. */}
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-4 md:px-5">
        <div className="min-w-0 flex-1">
          <h3 id="dashboard-institutes-title" className="flex items-center gap-2 text-base font-bold text-slate-800">
            <Building2 size={18} className="text-indigo-600" aria-hidden="true" />
            Institutes
          </h3>
          <p className="text-xs text-slate-500">
            {workingDays > 1
              ? `Present counts each instructor once per day they checked in, out of ${formatCount(workingDays)} working days. `
              : ''}
            Select a column heading to sort. Face enrolment under 80% is flagged for face-only institutes.
          </p>
        </div>
        <div className="shrink-0">
          <DateRangeFilter preset={preset} range={range} today={data.today} onChange={changeRange} />
        </div>
      </div>
      {rangeError && (
        <p role="alert" className="border-b border-rose-100 bg-rose-50 px-4 py-2 text-sm text-rose-700 md:px-5">
          {rangeError}
        </p>
      )}
      {waiting ? (
        <p className="p-6 text-sm text-slate-400" aria-live="polite">Loading institutes for this range…</p>
      ) : rows.length === 0 ? (
        <p className="p-6 text-sm text-slate-400">{rangeError ? 'No figures to show.' : 'No institutes have been added yet.'}</p>
      ) : (
        // Ten rows tall, then the rest scroll inside the card with the header
        // pinned, so the page below keeps its place however many institutes
        // there are.
        <div
          className={`overflow-auto overscroll-contain transition-opacity ${rangeLoading ? 'opacity-60' : ''}`}
          style={{ maxHeight: INSTITUTE_HEADER_HEIGHT + INSTITUTE_ROW_HEIGHT * INSTITUTE_VISIBLE_ROWS }}
          tabIndex={scrolls ? 0 : undefined}
          aria-label={scrolls ? 'Institutes, scrollable' : undefined}
        >
          <table className="w-full min-w-[860px] text-left text-sm">
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
                    <td className={cell}>
                      {row.mode === 'FACE_ONLY' ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-bold text-indigo-700">
                          <ScanFace size={12} aria-hidden="true" />Face
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">
                          <List size={12} aria-hidden="true" />Selector
                        </span>
                      )}
                    </td>
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
                      {row.unidentified > 0
                        ? <span className="inline-flex rounded-full bg-rose-600 px-2 py-0.5 text-xs font-bold text-white">{formatCount(row.unidentified)}</span>
                        : <span className="text-slate-400">0</span>}
                    </td>
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
  );
}

function Escalations({ data }: { data: DashboardData }) {
  const rows = data.escalations;
  return (
    <section className={`${CARD} p-4 md:p-5`} aria-labelledby="dashboard-escalations-title">
      <h3 id="dashboard-escalations-title" className="flex items-center gap-2 text-base font-bold text-slate-800">
        <ShieldAlert size={18} className="text-rose-600" aria-hidden="true" />
        Escalated this week
        {rows.length > 0 && <span className="rounded-full bg-rose-600 px-2 py-0.5 text-xs font-bold text-white tabular-nums">{rows.length}</span>}
      </h3>
      <p className="text-xs text-slate-500">3 or more non-compliant results since {weekdayLabel(data.week_start)}. Reporting partners are emailed each time.</p>
      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-slate-400">Nobody is escalated this week.</p>
      ) : (
        <ul className="mt-3 max-h-[312px] divide-y divide-slate-100 overflow-y-auto overscroll-contain pr-1">
          {rows.map((row) => (
            <li key={row.instructor_id} className="flex items-center gap-3 py-2.5">
              <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-slate-100 text-sm font-bold text-slate-600">
                {(row.name[0] || '?').toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-slate-800">{row.name}</span>
                <span className="block truncate text-xs text-slate-500">
                  {row.college_name}{row.top_checkpoint ? ` · most often: ${row.top_checkpoint}` : ''}
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center rounded-full border border-rose-600 bg-rose-600 px-2.5 py-1 text-xs font-bold text-white tabular-nums">
                {row.count} this week
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AttireCard({ data }: { data: DashboardData }) {
  const { attire, summary } = data;
  const rows = [
    { label: 'Saree', style: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200', count: attire.saree },
    { label: 'Kurti + Dupatta', style: 'bg-violet-50 text-violet-700 border-violet-200', count: attire.kurti },
    { label: 'Formal', style: 'bg-sky-50 text-sky-700 border-sky-200', count: attire.formal },
  ];
  const share = (count: number) => (attire.analysed ? (count / attire.analysed) * 100 : 0);
  const ofCheckIns = (count: number) => (summary.check_ins ? ` (${formatPercent((count / summary.check_ins) * 100)})` : '');
  return (
    <section className={`${CARD} p-4 md:p-5`} aria-labelledby="dashboard-attire-title">
      <h3 id="dashboard-attire-title" className="text-base font-bold text-slate-800">Women&apos;s attire this week</h3>
      <p className="text-xs text-slate-500 tabular-nums">
        From {formatCount(attire.analysed)} analysed check-in{attire.analysed === 1 ? '' : 's'}. The guideline is 3 saree and 3 kurti days a week.
      </p>
      {attire.analysed === 0 ? (
        <p className="mt-6 text-sm text-slate-400">No women&apos;s check-ins have been analysed this week yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((row) => (
            <li key={row.label} className="grid grid-cols-[8.5rem_1fr_5.5rem] items-center gap-3 text-sm">
              <span><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold ${row.style}`}>{row.label}</span></span>
              <span className="h-2.5 rounded-full bg-slate-100" aria-hidden="true">
                <span className="block h-2.5 rounded-full bg-slate-500" style={{ width: `${share(row.count)}%` }} />
              </span>
              <span className="text-right tabular-nums">
                <b className="text-slate-800">{Math.round(share(row.count))}%</b> <span className="text-slate-400">{formatCount(row.count)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-5 rounded-md border border-slate-100 bg-slate-50 p-3">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Image quality today</p>
        <div className="mt-2 flex items-baseline justify-between gap-3 text-sm tabular-nums">
          <span className="text-slate-600">Retake recommended</span>
          <span className="font-bold text-slate-800">{formatCount(summary.retake_recommended)}<span className="font-medium text-slate-400">{ofCheckIns(summary.retake_recommended)}</span></span>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3 text-sm tabular-nums">
          <span className="text-slate-600">Not assessed (body not visible)</span>
          <span className="font-bold text-slate-800">{formatCount(summary.unassessed)}<span className="font-medium text-slate-400">{ofCheckIns(summary.unassessed)}</span></span>
        </div>
      </div>
    </section>
  );
}

function ComplianceDelta({ data }: { data: DashboardData }) {
  const change = complianceChange(data.summary.compliance_percent, data.summary.compliance_same_day_last_week);
  const weekday = weekdayLabel(data.same_day_last_week);
  if (!change) {
    return <p className="mt-2 text-xs text-slate-500">No result last {weekday} to compare</p>;
  }
  const Icon = change.direction === 'up' ? TrendingUp : change.direction === 'down' ? TrendingDown : Minus;
  const tone = change.direction === 'up' ? 'text-emerald-700' : change.direction === 'down' ? 'text-rose-700' : 'text-slate-500';
  const sign = change.points > 0 ? '+' : '';
  return (
    <p className={`mt-2 inline-flex items-center gap-1 text-xs font-semibold tabular-nums ${tone}`}>
      <Icon size={14} aria-hidden="true" />
      {sign}{change.points.toFixed(1)} pts vs last {weekday}
    </p>
  );
}

export default function Dashboard({ onNavigate, canIdentify = false }: DashboardProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reloadVersion, setReloadVersion] = useState(0);
  const hasData = useRef(false);

  /**
   * Keeps the page current while it is on screen: a refresh every 30 seconds,
   * paused while the tab is hidden and caught up the moment it is shown again.
   * The previous figures stay visible during a refresh, so the page never
   * blanks while it updates.
   */
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | null = null;
    const path = '/api/v2/dashboard';

    const schedule = () => {
      clearTimeout(timer);
      if (!disposed && document.visibilityState === 'visible') {
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
      if (!hasData.current) setLoading(true);
      try {
        const next = await apiFetch<DashboardData>(path, { signal: controller.signal });
        if (!disposed) {
          hasData.current = true;
          setData(next);
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
  }, [reloadVersion]);

  const header = (
    <h2 id="dashboard-title" className="flex items-center gap-2 text-lg font-bold text-slate-800 sm:text-xl">
      <LayoutDashboard size={22} className="text-indigo-600" aria-hidden="true" />
      Dashboard
    </h2>
  );

  if (!data) {
    return (
      <section className="mx-auto flex w-full max-w-[1400px] flex-col gap-5" aria-labelledby="dashboard-title">
        {header}
        {loading && <BrandedLoader label="Loading dashboard" />}
        {!loading && error && (
          <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            <p className="font-semibold">The dashboard could not be loaded.</p>
            <p className="mt-1">{error}</p>
            <button
              type="button"
              onClick={() => setReloadVersion((value) => value + 1)}
              className="mt-3 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-rose-700"
            >
              Try again
            </button>
          </div>
        )}
      </section>
    );
  }

  const { summary } = data;
  return (
    <section className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 pb-2" aria-labelledby="dashboard-title">
      {header}

      {error && (
        <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-800">
          Showing the figures from {updatedAtLabel(data.generated_at, data.time_zone)}. The latest refresh failed: {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Present today" icon={UserCheck} iconClass="text-indigo-500">
          <div className="mt-2 flex items-baseline gap-1 tabular-nums">
            <span className="text-2xl font-extrabold text-slate-800">{formatCount(summary.present)}</span>
            <span className="text-sm font-semibold text-slate-400">/ {formatCount(summary.total_instructors)}</span>
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-slate-100" aria-hidden="true">
            <div className="h-1.5 rounded-full bg-indigo-600" style={{ width: `${Math.min(100, summary.present_percent ?? 0)}%` }} />
          </div>
          <p className="mt-2 text-xs text-slate-500 tabular-nums">
            {formatPercent(summary.present_percent)} · {formatCount(summary.not_checked_in)} not checked in
          </p>
        </KpiTile>

        <KpiTile label="Compliance" icon={Shirt} iconClass="text-cyan-600">
          <div className="mt-2 text-2xl font-extrabold text-slate-800 tabular-nums">{formatPercent(summary.compliance_percent)}</div>
          <ComplianceDelta data={data} />
          <p className="mt-1 text-xs text-slate-500 tabular-nums">{formatCount(summary.compliant)} of {formatCount(summary.analysed)} analysed</p>
        </KpiTile>

        <KpiTile label="Non-compliant" icon={CircleX} iconClass="text-rose-600">
          <div className="mt-2 text-2xl font-extrabold text-slate-800 tabular-nums">{formatCount(summary.non_compliant)}</div>
          <p className="mt-2 text-xs text-slate-500 tabular-nums">
            {summary.analysed ? `${formatPercent((summary.non_compliant / summary.analysed) * 100)} of analysed check-ins` : 'Nothing analysed yet today'}
          </p>
          <TileLink onClick={() => onNavigate('daily-records')}>View in Daily Records</TileLink>
        </KpiTile>

        <KpiTile label="Checked out" icon={LogOut} iconClass="text-slate-500">
          <div className="mt-2 text-2xl font-extrabold text-slate-800 tabular-nums">{formatCount(summary.checked_out)}</div>
          <p className="mt-2 text-xs text-slate-500 tabular-nums">{formatCount(summary.on_duty)} still on duty</p>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            {formatCount(summary.missed_checkout_previous_day)} missed check-out on {shortDayLabel(data.previous_working_day)}
          </p>
        </KpiTile>

        <KpiTile label="Pending AI" icon={Clock} iconClass="text-amber-500">
          <div className="mt-2 text-2xl font-extrabold text-slate-800 tabular-nums">{formatCount(summary.pending)}</div>
          <p className="mt-2 text-xs text-slate-500 tabular-nums">
            {summary.pending ? `Oldest waiting ${formatWait(summary.oldest_pending_seconds)}` : 'Nothing waiting'}
          </p>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">{formatCount(summary.errors)} analysis error{summary.errors === 1 ? '' : 's'} today</p>
        </KpiTile>

        <KpiTile
          label="Unidentified"
          icon={UserRoundSearch}
          iconClass="text-rose-600"
          tone={summary.unidentified_waiting > 0 ? 'alert' : 'default'}
        >
          <div className="mt-2 text-2xl font-extrabold text-slate-800 tabular-nums">{formatCount(summary.unidentified_waiting)}</div>
          <p className="mt-2 text-xs text-slate-600 tabular-nums">
            {summary.unidentified_waiting ? 'Waiting to be named' : 'Nobody waiting to be named'}
            {summary.unidentified_today ? ` · ${formatCount(summary.unidentified_today)} today` : ''}
          </p>
          {canIdentify && summary.unidentified_waiting > 0 && (
            <TileLink tone="rose" onClick={() => onNavigate('unidentified')}>Open queue</TileLink>
          )}
        </KpiTile>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <TrendChart trend={data.trend} />
        <StatusCard data={data} />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Escalations data={data} />
        <FailedCheckpoints data={data} />
      </div>

      <InstitutesTable data={data} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <AttireCard data={data} />
      </div>
    </section>
  );
}
