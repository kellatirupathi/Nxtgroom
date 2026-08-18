import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, Image as ImageIcon, TriangleAlert, XCircle } from 'lucide-react';
import { apiFetch } from '../api';
import GroomingReport from './GroomingReport';
import { AiSummary, ReportFlags, VisibleRegions, WeeklyRotationCard } from './ReportMeta';
import BrandedLoader from './BrandedLoader';
import PhotoViewer from './PhotoViewer';
import type { Evaluation, WeeklyRotation } from '../types';

interface PublicReportPageProps {
  token: string;
  kind: 'day' | 'week';
  date: string;
}

interface DayResponse {
  instructor: { name: string; role: string | null; institute: string | null };
  date: string;
  attendance: {
    check_in_time: string | null;
    check_out_time: string | null;
    status: string | null;
    attire_type: string | null;
    remarks: string | null;
    location_address: string | null;
    has_checkin_photo?: boolean;
    has_checkout_photo?: boolean;
  };
  evaluation: Evaluation | null;
  /** Counted from the week, and supplied for women only. */
  weekly_rotation?: WeeklyRotation | null;
}

interface WeekDay {
  date: string;
  present: boolean;
  check_in_time: string | null;
  check_out_time: string | null;
  status: string | null;
  attire_type: string | null;
  missed_checkout: boolean;
}

interface WeekResponse {
  instructor: { name: string; role: string | null; institute: string | null };
  week: {
    week_start: string;
    week_end: string;
    days: WeekDay[];
    present_days: number;
    compliant_days: number;
    non_compliant_days: number;
    review_days: number;
    saree_days: number;
    kurti_days: number;
    formal_days: number;
    missed_checkouts: number;
  };
  month: {
    month: string;
    present_days: number;
    compliant_days: number;
    non_compliant_days: number;
    review_days: number;
    saree_days: number;
    kurti_days: number;
    formal_days: number;
    missed_checkouts: number;
  };
}

const ATTIRE_LABELS: Record<string, string> = {
  FORMAL: 'Formal',
  SAREE: 'Saree',
  KURTI_WITH_DUPATTA: 'Kurti with dupatta',
};

function StatusPill({ status }: { status: string | null }) {
  const map: Record<string, { text: string; style: string; Icon: typeof CheckCircle2 }> = {
    compliant: { text: 'Compliant', style: 'bg-emerald-50 text-emerald-700 border-emerald-200', Icon: CheckCircle2 },
    non_compliant: { text: 'Non-compliant', style: 'bg-rose-50 text-rose-700 border-rose-200', Icon: XCircle },
    error: { text: 'Analysis error', style: 'bg-slate-100 text-slate-600 border-slate-200', Icon: TriangleAlert },
  };
  const match = status ? map[status] : undefined;
  if (!match) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-700">
        <Clock size={12} aria-hidden="true" /> Pending
      </span>
    );
  }
  const { text, style, Icon } = match;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-bold whitespace-nowrap ${style}`}>
      <Icon size={12} aria-hidden="true" /> {text}
    </span>
  );
}

function formatTime(value: string | null) {
  if (!value) return '--';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(value: string) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3 text-center">
      <p className="text-lg font-extrabold text-slate-800">{value}</p>
      <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">{label}</p>
    </div>
  );
}

/**
 * The page an instructor opens from a report email.
 *
 * Unauthenticated: the recipient has no FacultyTrack account, and the token in
 * the URL is the credential. It shows one fixed period — the one the email was
 * about — with no controls for browsing to another week, so a link cannot be
 * walked backwards through someone's history.
 */
export default function PublicReportPage({ token, kind, date }: PublicReportPageProps) {
  const [day, setDay] = useState<DayResponse | null>(null);
  const [week, setWeek] = useState<WeekResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [photoDate, setPhotoDate] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    const path = `/api/v2/reports/${encodeURIComponent(token)}/${kind}/${encodeURIComponent(date)}`;
    apiFetch<DayResponse | WeekResponse>(path, { auth: false })
      .then((data) => {
        if (disposed) return;
        if (kind === 'day') setDay(data as DayResponse);
        else setWeek(data as WeekResponse);
      })
      .catch((requestError) => {
        if (disposed) return;
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [token, kind, date]);

  if (loading) return <BrandedLoader label="Loading your report" />;

  if (error) {
    return (
      <main className="flex min-h-[100svh] items-center justify-center bg-[#f8f9fc] p-6">
        <div className="w-full max-w-md rounded-md border border-slate-200 bg-white p-8 text-center shadow-sm">
          <img src="/logo.png" alt="" className="mx-auto mb-4 h-12 w-12 object-contain" />
          <h1 className="text-lg font-extrabold text-slate-800">Report unavailable</h1>
          <p className="mt-2 text-sm text-slate-600">{error}</p>
          <p className="mt-4 text-xs text-slate-400">
            Report links are personal. If this one no longer works, ask an administrator for a new one.
          </p>
        </div>
      </main>
    );
  }

  const instructor = day?.instructor || week?.instructor;

  return (
    <main className="min-h-[100svh] bg-[#f8f9fc] py-8 px-4">
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-6 flex items-center gap-3">
          <img src="/logo.png" alt="" className="h-10 w-10 object-contain" />
          <div className="min-w-0">
            <p className="text-sm font-extrabold text-slate-800">FacultyTrack</p>
            <p className="text-[11px] font-medium uppercase tracking-widest text-slate-400">
              Appearance report
            </p>
          </div>
        </header>

        <section className="mb-6 rounded-md border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-xl font-extrabold text-slate-800">{instructor?.name}</h1>
            {kind === 'day' && day?.attendance.has_checkin_photo && (
              <button
                type="button"
                onClick={() => setPhotoDate(date)}
                aria-label="View the check-in photo"
                title="View the check-in photo"
                className="shrink-0 rounded-md border border-indigo-100 bg-indigo-50 p-2 text-indigo-700 transition-colors hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <ImageIcon size={18} aria-hidden="true" />
              </button>
            )}
          </div>
          <p className="mt-0.5 text-sm text-slate-500">
            {[instructor?.role, instructor?.institute].filter(Boolean).join(' · ') || '--'}
          </p>
          <p className="mt-3 text-sm font-semibold text-slate-700">
            {kind === 'day'
              ? formatDay(date)
              : `${formatDay(week?.week.week_start ?? date)} to ${formatDay(week?.week.week_end ?? date)}`}
          </p>
        </section>

        {kind === 'day' && day && (
          <>
            <section className="mb-6 rounded-md border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                <StatusPill status={day.attendance.status} />
                {day.attendance.attire_type && ATTIRE_LABELS[day.attendance.attire_type] && (
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold text-slate-600">
                    {ATTIRE_LABELS[day.attendance.attire_type]}
                  </span>
                )}
                </div>
                {day.evaluation && <ReportFlags evaluation={day.evaluation} />}
              </div>
              <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Check-in</dt>
                  <dd className="mt-0.5 font-semibold text-slate-700">{formatTime(day.attendance.check_in_time)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Check-out</dt>
                  <dd className="mt-0.5 font-semibold text-slate-700">{formatTime(day.attendance.check_out_time)}</dd>
                </div>
                {day.attendance.location_address && (
                  <div className="col-span-2 sm:col-span-1">
                    <dt className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Location</dt>
                    <dd className="mt-0.5 font-semibold text-slate-700">{day.attendance.location_address}</dd>
                  </div>
                )}
              </dl>
              <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="space-y-3">
                  <AiSummary summary={day.evaluation?.ai_summary || day.attendance.remarks || undefined} />
                  <VisibleRegions regions={day.evaluation?.visible_regions} />
                </div>
                <WeeklyRotationCard rotation={day.weekly_rotation} />
              </div>
            </section>

            <section className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="mb-4 text-base font-extrabold text-slate-800">Detailed Appearance Report</h2>
              {day.evaluation ? (
                <GroomingReport evaluation={day.evaluation} />
              ) : (
                <p className="py-6 text-center text-sm text-slate-500">
                  The checkpoint detail for this check-in is not available.
                </p>
              )}
            </section>
          </>
        )}

        {kind === 'week' && week && (
          <>
            <section className="mb-6">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-500">This week</h2>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                <Stat label="Days present" value={`${week.week.present_days}/6`} />
                <Stat label="Compliant" value={week.week.compliant_days} />
                <Stat label="Needs review" value={week.week.review_days} />
                <Stat label="Non-compliant" value={week.week.non_compliant_days} />
                <Stat label="Formal" value={week.week.formal_days} />
                <Stat label="Saree" value={week.week.saree_days} />
                <Stat label="Kurti" value={week.week.kurti_days} />
                <Stat label="Missed check-outs" value={week.week.missed_checkouts} />
              </div>
            </section>

            <section className="mb-6 overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="p-3">Day</th>
                      <th className="p-3">Check-in</th>
                      <th className="p-3">Check-out</th>
                      <th className="p-3">Result</th>
                      <th className="p-3">Attire</th>
                      <th className="p-3">Photo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {week.week.days.map((row) => (
                      <tr key={row.date} className={row.present ? '' : 'bg-slate-50/60'}>
                        <td className="whitespace-nowrap p-3 font-semibold text-slate-700">{formatDay(row.date)}</td>
                        <td className="whitespace-nowrap p-3 text-slate-600">{formatTime(row.check_in_time)}</td>
                        <td className="whitespace-nowrap p-3 text-slate-600">{formatTime(row.check_out_time)}</td>
                        <td className="p-3">
                          {row.present ? <StatusPill status={row.status} /> : <span className="text-xs text-slate-400">No check-in</span>}
                        </td>
                        <td className="whitespace-nowrap p-3 text-slate-600">
                          {row.attire_type ? (ATTIRE_LABELS[row.attire_type] || '--') : '--'}
                        </td>
                        <td className="p-3">
                          {row.present ? (
                            <button
                              type="button"
                              onClick={() => setPhotoDate(row.date)}
                              aria-label={`View the photo from ${formatDay(row.date)}`}
                              title="View photo"
                              className="rounded-md border border-indigo-100 bg-indigo-50 p-1.5 text-indigo-700 transition-colors hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            >
                              <ImageIcon size={14} aria-hidden="true" />
                            </button>
                          ) : (
                            <span className="text-xs text-slate-300">--</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-500">
                This month so far
              </h2>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                <Stat label="Days present" value={week.month.present_days} />
                <Stat label="Compliant" value={week.month.compliant_days} />
                <Stat label="Needs review" value={week.month.review_days} />
                <Stat label="Non-compliant" value={week.month.non_compliant_days} />
                <Stat label="Formal" value={week.month.formal_days} />
                <Stat label="Saree" value={week.month.saree_days} />
                <Stat label="Kurti" value={week.month.kurti_days} />
                <Stat label="Missed check-outs" value={week.month.missed_checkouts} />
              </div>
            </section>
          </>
        )}

        {photoDate && (
          <PhotoViewer
            // The token in the path is the credential here, so no bearer token
            // is sent: the recipient has no account to authenticate with.
            path={`/api/v2/reports/${encodeURIComponent(token)}/day/${encodeURIComponent(photoDate)}/photo/checkin`}
            auth={false}
            kind="checkin"
            title={instructor?.name ?? 'Instructor'}
            subtitle={formatDay(photoDate)}
            onClose={() => setPhotoDate(null)}
          />
        )}

        <p className="mt-8 text-center text-xs text-slate-400">
          This is an assistive screening result and should be reviewed before any action is taken.
          <br />
          This link is personal to you. Please do not forward it.
        </p>
      </div>
    </main>
  );
}
