import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { History, Search, MapPin, CheckCircle2, XCircle, Clock, TriangleAlert, CircleAlert, Image as ImageIcon, LogOut } from 'lucide-react';
import { apiFetchAllPages } from '../api';
import PhotoViewer from './PhotoViewer';
import {
  attendancePath,
  filterAttendanceRecords,
  localDateValue,
  uniqueRecordValues,
} from '../attendanceFilters';
import { formatCoordinates, hasEvaluation, normalizeAttendanceStatus } from '../status';
import type { AttendanceRecord } from '../types';

interface DailyAttendanceTableProps {
  onRowClick: (record: AttendanceRecord) => void;
}

function StatusBadge({ status }: { status?: string }) {
  switch (normalizeAttendanceStatus(status)) {
    case 'compliant':
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-emerald-50 text-emerald-600 border border-emerald-200"><CheckCircle2 size={12} aria-hidden="true" /> Compliant</span>;
    case 'non_compliant':
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-rose-50 text-rose-600 border border-rose-200"><XCircle size={12} aria-hidden="true" /> Non-compliant</span>;
    case 'review_required':
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-amber-50 text-amber-700 border border-amber-200"><CircleAlert size={12} aria-hidden="true" /> Review required</span>;
    case 'error':
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-slate-100 text-slate-600 border border-slate-200"><TriangleAlert size={12} aria-hidden="true" /> Analysis error</span>;
    default:
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-amber-50 text-amber-600 border border-amber-200"><Clock size={12} aria-hidden="true" /> Pending AI</span>;
  }
}

/** Formal / Saree / Kurti, classified by the AI independently of pass or fail. */
function AttireTag({ attire }: { attire?: string | null }) {
  const labels: Record<string, { text: string; style: string }> = {
    FORMAL: { text: 'Formal', style: 'bg-sky-50 text-sky-700 border-sky-200' },
    SAREE: { text: 'Saree', style: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200' },
    KURTI_WITH_DUPATTA: { text: 'Kurti + Dupatta', style: 'bg-violet-50 text-violet-700 border-violet-200' },
  };
  const match = attire ? labels[attire] : undefined;
  // UNKNOWN and missing both render as a dash: an unclassified photo must not
  // be presented as though it were one of the three.
  if (!match) return <span className="text-xs text-slate-300">--</span>;
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold whitespace-nowrap ${match.style}`}>
      {match.text}
    </span>
  );
}

function formatTime(isoString?: string | null) {
  if (!isoString) return '--';
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(isoString?: string | null) {
  if (!isoString) return '--';
  return new Date(isoString).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function DailyAttendanceTable({ onRowClick }: DailyAttendanceTableProps) {
  const today = useMemo(() => localDateValue(), []);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [photoTarget, setPhotoTarget] = useState<
    { record: AttendanceRecord; kind: 'checkin' | 'checkout' } | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dateFilter, setDateFilter] = useState(today);
  const [roleFilter, setRoleFilter] = useState('');
  const [collegeFilter, setCollegeFilter] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeController: AbortController | null = null;
    const endpoint = attendancePath(dateFilter);
    setRecords([]);
    setLoading(true);

    // Poll quickly while AI evaluations are still running so finished results
    // surface within seconds, then fall back to a slow idle cadence.
    const schedule = (hasPendingWork: boolean) => {
      clearTimeout(timer);
      if (!disposed && document.visibilityState === 'visible') {
        timer = setTimeout(() => run(false), hasPendingWork ? 3_000 : 30_000);
      }
    };

    const run = async (showLoading: boolean) => {
      if (disposed || activeController) return;
      if (document.visibilityState !== 'visible') {
        if (showLoading) setLoading(false);
        return;
      }
      const controller = new AbortController();
      activeController = controller;
      if (showLoading) setLoading(true);
      let pendingWork = false;
      try {
        const data = await apiFetchAllPages<AttendanceRecord>(endpoint, {
          pageSize: 1_000,
          signal: controller.signal,
        });
        const rows = Array.isArray(data) ? data : [];
        pendingWork = rows.some(
          (row) => normalizeAttendanceStatus(row.status) === 'pending'
        );
        if (!disposed) {
          setRecords(rows);
          setError('');
        }
      } catch (requestError) {
        if (!disposed && !controller.signal.aborted && (requestError as { status?: number })?.status !== 401) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      } finally {
        if (!disposed && showLoading) setLoading(false);
        activeController = null;
        schedule(pendingWork);
      }
    };

    const handleVisibilityChange = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') {
        activeController?.abort();
      } else if (!activeController) {
        run(true);
      }
    };

    run(true);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      clearTimeout(timer);
      activeController?.abort();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [dateFilter]);

  const roles = useMemo(
    () => uniqueRecordValues(records, 'instructor_role', roleFilter),
    [records, roleFilter],
  );
  const colleges = useMemo(
    () => uniqueRecordValues(records, 'college_name', collegeFilter),
    [records, collegeFilter],
  );
  const filteredRecords = useMemo(
    () => filterAttendanceRecords(records, {
      search,
      role: roleFilter,
      college: collegeFilter,
    }),
    [records, search, roleFilter, collegeFilter],
  );

  const openRecord = (record: AttendanceRecord) => {
    if (hasEvaluation(record.status)) onRowClick(record);
  };

  const handleDateChange = (event: ChangeEvent<HTMLInputElement>) => {
    setRecords([]);
    setLoading(true);
    setDateFilter(event.target.value);
  };

  return (
    <section className="w-full flex flex-col h-full" aria-labelledby="daily-records-title" aria-busy={loading}>
      {/* One band: the title on the left, the filters on the right. The
          subtitle is gone and the heading no longer wraps, so the filters stay
          on the same line instead of pushing the table down a row. Labels live
          in aria-label, since the controls read clearly without visible ones. */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h2 id="daily-records-title" className="flex shrink-0 items-center gap-2 text-xl font-bold text-slate-800">
          <History size={22} className="text-indigo-600" aria-hidden="true" />
          Daily Attendance Records
        </h2>

        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <input
            type="date"
            aria-label="Filter by date"
            value={dateFilter}
            max={today}
            onChange={handleDateChange}
            className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
          />
          <select
            aria-label="Filter by institute"
            value={collegeFilter}
            onChange={(event) => setCollegeFilter(event.target.value)}
            className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
          >
            <option value="">All institutes</option>
            {colleges.map((college) => <option key={college} value={college}>{college}</option>)}
          </select>
          <select
            aria-label="Filter by instructor role"
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value)}
            className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
          >
            <option value="">All roles</option>
            {roles.map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
          <span className="relative flex-1 min-w-[10rem] sm:flex-none">
            <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search attendance records"
              maxLength={120}
              placeholder="Search name, institute, remarks…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 w-full sm:w-56 rounded-md border border-slate-300 bg-white py-0 pl-8 pr-3 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            />
          </span>
        </div>
      </div>

      {error && <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}

      <div className="bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden flex-1 flex flex-col">
        <div className="overflow-x-auto flex-1">
          {/*
            table-fixed with explicit widths, because auto layout was sizing
            columns from their content and wrapping "Vikram Balai" and
            "Aug 17, 2026" onto two and three lines. Every column now gets a
            width that fits one line, and the table scrolls horizontally rather
            than compressing to fit.
          */}
          {/*
            An explicit total width, not w-max. w-max sizes the table to its
            content, which let the Remark column grow to fit a paragraph and
            scroll the row far off screen instead of truncating at 320px.
            1610px is the sum of the column widths below.
          */}
          <table className="text-left border-collapse table-fixed w-[1780px] max-w-none">
            <thead className="sticky top-0 bg-slate-50 z-10 shadow-sm">
              <tr className="border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                <th className="p-4 w-[200px]">Instructor Name</th>
                <th className="p-4 w-[150px]">Role</th>
                <th className="p-4 w-[160px]">Institute</th>
                <th className="p-4 w-[130px]">Date</th>
                <th className="p-4 w-[110px]">Check-In</th>
                <th className="p-4 w-[110px]">Check-Out</th>
                <th className="p-4 w-[190px]">Coordinates</th>
                <th className="p-4 w-[150px]">Status</th>
                <th className="p-4 w-[170px]">Attire</th>
                <th className="p-4 w-[90px]">Photo</th>
                <th className="p-4 w-[320px]">Remark</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && records.length === 0 ? (
                <tr><td colSpan={11} className="p-8 text-center text-slate-400">Loading attendance records…</td></tr>
              ) : records.length === 0 ? (
                <tr><td colSpan={11} className="p-8 text-center text-slate-400">No attendance records found for this date.</td></tr>
              ) : filteredRecords.length === 0 ? (
                <tr><td colSpan={11} className="p-8 text-center text-slate-400">No records match the selected filters.</td></tr>
              ) : filteredRecords.map((record) => {
                const canOpen = hasEvaluation(record.status);
                return (
                  <tr
                    key={record._id}
                    onClick={() => openRecord(record)}
                    onKeyDown={(event) => {
                      if (canOpen && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        openRecord(record);
                      }
                    }}
                    tabIndex={canOpen ? 0 : undefined}
                    aria-label={canOpen ? `Open evaluation for ${record.instructor_name}` : undefined}
                    className={`transition-colors ${canOpen ? 'hover:bg-slate-50 cursor-pointer focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500' : 'opacity-80'}`}
                  >
                    {/* truncate on every text cell: one line, an ellipsis when
                        it overflows, and the full value in the tooltip. */}
                    <td className="p-4 font-bold text-slate-800 truncate" title={record.instructor_name || ''}>{record.instructor_name}</td>
                    <td className="p-4 text-sm font-medium text-slate-500 truncate" title={record.instructor_role || ''}>{record.instructor_role || '--'}</td>
                    <td className="p-4 text-sm font-medium text-slate-600 truncate" title={record.college_name || ''}>{record.college_name || 'Unknown'}</td>
                    <td className="p-4 text-sm font-medium text-slate-600 whitespace-nowrap">{formatDate(record.date)}</td>
                    <td className="p-4 text-sm font-bold text-slate-700 whitespace-nowrap">{formatTime(record.check_in_time)}</td>
                    <td className="p-4 text-sm font-bold text-slate-700 whitespace-nowrap">{formatTime(record.check_out_time)}</td>
                    <td className="p-4 text-sm text-slate-500 truncate">
                      {record.location_coordinates ? (
                        <span className="flex items-center gap-1.5 text-indigo-600 font-medium whitespace-nowrap" title="Latitude, longitude">
                          <MapPin size={14} className="shrink-0" aria-hidden="true" /> {formatCoordinates(record.location_coordinates)}
                        </span>
                      ) : '--'}
                    </td>
                    <td className="p-4 whitespace-nowrap"><StatusBadge status={record.status} /></td>
                    <td className="p-4 whitespace-nowrap"><AttireTag attire={record.attire_type} /></td>
                    <td className="p-4">
                      {/* stopPropagation: the row itself opens the evaluation
                          detail, and viewing a photo should not also do that. */}
                      <div className="flex items-center gap-1.5 whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                        {record.check_in_photo_key ? (
                          <button
                            type="button"
                            title="View check-in photo"
                            aria-label={`View check-in photo for ${record.instructor_name}`}
                            onClick={() => setPhotoTarget({ record, kind: 'checkin' })}
                            className="rounded-md border border-indigo-100 bg-indigo-50 p-1.5 text-indigo-700 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          >
                            <ImageIcon size={15} aria-hidden="true" />
                          </button>
                        ) : (
                          <span className="text-xs text-slate-300">--</span>
                        )}
                        {record.check_out_photo_key && (
                          <button
                            type="button"
                            title="View check-out photo"
                            aria-label={`View check-out photo for ${record.instructor_name}`}
                            onClick={() => setPhotoTarget({ record, kind: 'checkout' })}
                            className="rounded-md border border-rose-100 bg-rose-50 p-1.5 text-rose-700 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500"
                          >
                            <LogOut size={15} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="p-4 text-sm text-slate-500 truncate" title={record.remarks || ''}>{record.remarks || '--'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {photoTarget && (
        <PhotoViewer
          attendanceId={String(photoTarget.record._id)}
          kind={photoTarget.kind}
          title={photoTarget.record.instructor_name || 'Instructor'}
          subtitle={formatTime(
            photoTarget.kind === 'checkin'
              ? photoTarget.record.check_in_time
              : photoTarget.record.check_out_time,
          )}
          onClose={() => setPhotoTarget(null)}
        />
      )}
    </section>
  );
}
