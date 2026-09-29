import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  CircleX,
  Clock,
  LayoutDashboard,
  LogOut,
  Minus,
  Shirt,
  TrendingDown,
  TrendingUp,
  UserCheck,
  UserRoundSearch,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { apiFetch } from '../api';
import BrandedLoader from './BrandedLoader';
import {
  complianceChange,
  DASHBOARD_REFRESH_MS,
  formatCount,
  formatPercent,
  formatWait,
  shortDayLabel,
  updatedAtLabel,
  weekdayLabel,
} from '../dashboardFormat';
import type {
  DashboardData,
} from '../types';

interface DashboardProps {
  /** Moves to another screen, e.g. Daily Records or the Unidentified queue. */
  onNavigate: (tab: string) => void;
  /** Whether this account may open the Unidentified queue. */
  canIdentify?: boolean;
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
    </section>
  );
}
