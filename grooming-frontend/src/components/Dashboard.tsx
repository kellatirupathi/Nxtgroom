import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  LayoutDashboard,
  LogOut,
  Minus,
  ShieldAlert,
  Shirt,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  UserCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { apiFetch } from '../api';
import BrandedLoader from './BrandedLoader';
import {
  complianceChange,
  DASHBOARD_REFRESH_MS,
  formatCount,
  formatPercent,
  shortDayLabel,
  tooltipDayLabel,
  updatedAtLabel,
  weekdayLabel,
} from '../dashboardFormat';
import type {
  DashboardData,
  DashboardStatusKey,
  DashboardTrendDay,
} from '../types';

interface DashboardProps {
  /** Moves to another screen, such as Daily Records. */
  onNavigate: (tab: string) => void;
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

function Escalations({ data }: { data: DashboardData }) {
  const rows = data.escalations;
  return (
    <section className={`${CARD} p-4 md:p-5`} aria-labelledby="dashboard-escalations-title">
      <h3 id="dashboard-escalations-title" className="flex items-center gap-2 text-base font-bold text-slate-800">
        <ShieldAlert size={18} className="text-rose-600" aria-hidden="true" />
        Escalated this week
        {rows.length > 0 && <span className="rounded-full bg-rose-600 px-2 py-0.5 text-xs font-bold text-white tabular-nums">{rows.length}</span>}
      </h3>
      <p className="text-xs text-slate-500">Non-compliant at check-in on 3 or more days in a row since {weekdayLabel(data.week_start)}. Reporting partners are emailed on each day the run continues.</p>
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
                {row.count} days in a row
              </span>
            </li>
          ))}
        </ul>
      )}
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

export default function Dashboard({ onNavigate }: DashboardProps) {
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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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

      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <TrendChart trend={data.trend} />
        <StatusCard data={data} />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Escalations data={data} />
        <FailedCheckpoints data={data} />
      </div>
    </section>
  );
}
