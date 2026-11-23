import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, MapPin, CheckCircle2, CircleAlert, XCircle, Clock, TriangleAlert, FileText, Image as ImageIcon, LogOut, Trash2, SlidersHorizontal, Download, X, ChevronRight } from 'lucide-react';
import { apiFetchAllPages, apiJson } from '../api';
import PhotoViewer from './PhotoViewer';
import AttendanceFilterDrawer from './AttendanceFilterDrawer';
import ColumnHeader, { OptionsFilter, TextFilter } from './ColumnHeader';
import DateRangeFilter from './DateRangeFilter';
import { nextColumnSort, sortRows, textMatches, timeValue, type ColumnSort } from '../lib/tableSort';
import { downloadAttendanceCsv } from '../attendanceExport';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './useToast';
import {
  attendanceSessionDateLabel,
  attendanceRangePath,
  checkoutDateTimeLabel,
  formatAttendanceTime,
  rangeForPreset,
  type DatePreset,
  type DateRange,
  type EscalationFilter,
  ESCALATION_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
  escalationLabel,
  filterAttendanceRecords,
  loadRecordsFilters,
  localDateValue,
  recordsFiltersFromQuery,
  recordsFiltersToQuery,
  saveRecordsFilters,
  spreadEscalation,
  uniqueRecordValues,
} from '../attendanceFilters';
import { publicDayReportPath, writeQueryParams } from '../routes';
import { canOpenRecord, formatCoordinates, normalizeAttendanceStatus } from '../status';
import type { AttendanceEscalation, AttendanceRecord, AttendanceStatus } from '../types';

interface DailyAttendanceTableProps {
  onRowClick: (record: AttendanceRecord) => void;
  canBulkDelete?: boolean;
}

interface BulkDeleteResult {
  message: string;
  deleted_ids: string[];
  failed: Array<{ attendance_id: string; detail: string }>;
}

function StatusBadge({ status }: { status?: string }) {
  switch (normalizeAttendanceStatus(status)) {
    case 'compliant':
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-emerald-50 text-emerald-600 border border-emerald-200"><CheckCircle2 size={12} aria-hidden="true" /> Compliant</span>;
    case 'non_compliant':
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-rose-50 text-rose-600 border border-rose-200"><XCircle size={12} aria-hidden="true" /> Non-compliant</span>;
    case 'unassessed':
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-amber-50 text-amber-700 border border-amber-200" title="The photograph did not show enough to judge"><CircleAlert size={12} aria-hidden="true" /> Not assessed</span>;
    case 'error':
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-slate-100 text-slate-600 border border-slate-200"><TriangleAlert size={12} aria-hidden="true" /> Analysis error</span>;
    default:
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-amber-50 text-amber-600 border border-amber-200"><Clock size={12} aria-hidden="true" /> Pending AI</span>;
  }
}

function AttireTag({ attire }: { attire?: string | null }) {
  const labels: Record<string, { text: string; style: string }> = {
    FORMAL: { text: 'Formal', style: 'bg-sky-50 text-sky-700 border-sky-200' },
    SAREE: { text: 'Saree', style: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200' },
    KURTI_WITH_DUPATTA: { text: 'Kurti + Dupatta', style: 'bg-violet-50 text-violet-700 border-violet-200' },
    ABAYA: { text: 'Abaya', style: 'bg-teal-50 text-teal-700 border-teal-200' },
    KURTA_PAJAMA: { text: 'Kurta + Payjama', style: 'bg-amber-50 text-amber-700 border-amber-200' },
  };
  const match = attire ? labels[attire] : undefined;
  if (!match) return <span className="text-xs text-slate-300">--</span>;
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold whitespace-nowrap ${match.style}`}>
      {match.text}
    </span>
  );
}

function EscalationTag({ escalation, today }: { escalation?: AttendanceEscalation | null; today: string }) {
  const label = escalationLabel(escalation, today);
  if (!label) return <span className="text-xs text-slate-300">--</span>;
  return (
    <span
      title={label.title}
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-rose-600 bg-rose-600 px-2.5 py-1 text-xs font-bold whitespace-nowrap text-white"
    >
      <TriangleAlert size={12} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{label.text}</span>
    </span>
  );
}

const MOBILE_DATE_CHIPS: ReadonlyArray<{ value: DatePreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'last_week', label: 'Last 7 days' },
  { value: 'last_month', label: 'Last 30 days' },
];

const MOBILE_STATUS_CHIPS: ReadonlyArray<{ value: AttendanceStatus | ''; label: string; active: string }> = [
  { value: '', label: 'All', active: 'border-slate-900 bg-slate-900 text-white' },
  { value: 'non_compliant', label: 'Non-compliant', active: 'border-rose-300 bg-rose-50 text-rose-700' },
  { value: 'compliant', label: 'Compliant', active: 'border-emerald-300 bg-emerald-50 text-emerald-700' },
  { value: 'pending', label: 'Pending', active: 'border-amber-300 bg-amber-50 text-amber-700' },
  { value: 'unassessed', label: 'Not assessed', active: 'border-amber-300 bg-amber-50 text-amber-700' },
];

const AVATAR_TONES = [
  'bg-indigo-50 text-indigo-700',
  'bg-fuchsia-50 text-fuchsia-700',
  'bg-cyan-50 text-cyan-700',
  'bg-amber-50 text-amber-700',
  'bg-emerald-50 text-emerald-700',
];

function initialsOf(name?: string | null): string {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return `${parts[0][0]}${parts.length > 1 ? parts[parts.length - 1][0] : ''}`.toUpperCase();
}

function avatarTone(name?: string | null): string {
  const text = String(name || '');
  let sum = 0;
  for (let index = 0; index < text.length; index += 1) sum += text.charCodeAt(index);
  return AVATAR_TONES[sum % AVATAR_TONES.length];
}

function MobileRecordItem({
  record,
  today,
  onOpen,
}: {
  record: AttendanceRecord;
  today: string;
  onOpen: (record: AttendanceRecord) => void;
}) {
  const openable = canOpenRecord(record.status);
  const escalated = Boolean(escalationLabel(record.escalation, today));
  const checkOut = record.check_out_time ? formatAttendanceTime(record.check_out_time) : '—';
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(record)}
        disabled={!openable}
        aria-label={`${record.instructor_name || 'Instructor'}, ${record.college_name || ''}. ${openable ? 'Open the report' : 'Analysis in progress'}`}
        className="block w-full rounded-2xl border border-slate-200 bg-white p-3.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-default disabled:hover:bg-white"
      >
        <span className="flex items-center gap-3">
          <span aria-hidden="true" className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full text-sm font-bold ${avatarTone(record.instructor_name)}`}>
            {initialsOf(record.instructor_name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-bold text-slate-900">{record.instructor_name || 'Unknown'}</span>
            <span className="mt-0.5 block truncate text-[13px] text-slate-500">
              {[record.college_name, record.instructor_role].filter(Boolean).join(' · ') || '--'}
            </span>
          </span>
          <StatusBadge status={record.status} />
        </span>
        <span className="mt-2.5 flex items-center gap-3 border-t border-slate-100 pt-2.5 text-xs text-slate-500">
          <span>In <b className="text-slate-900">{formatAttendanceTime(record.check_in_time)}</b></span>
          <span>Out <b className="text-slate-900">{checkOut}</b></span>
          <span className="ml-auto flex min-w-0 items-center gap-1.5">
            {escalated
              ? <EscalationTag escalation={record.escalation} today={today} />
              : <AttireTag attire={record.attire_type} />}
            {openable && <ChevronRight size={16} className="shrink-0 text-slate-400" aria-hidden="true" />}
          </span>
        </span>
      </button>
    </li>
  );
}

const ATTIRE_LABELS: Record<string, string> = {
  FORMAL: 'Formal',
  SAREE: 'Saree',
  KURTI_WITH_DUPATTA: 'Kurti + Dupatta',
  ABAYA: 'Abaya',
  KURTA_PAJAMA: 'Kurta + Payjama',
};

// key: what the header sorts and filters by; columns without one are plain.
const RECORD_COLUMNS = [
  { label: 'Instructor Name', key: 'name', width: 'w-[160px] lg:w-[220px]' },
  { label: 'Role', key: 'role', width: 'w-[130px] lg:w-[160px]' },
  { label: 'Institute', key: 'institute', width: 'w-[140px] lg:w-[170px]' },
  { label: 'Date', key: 'date', width: 'w-[122px] lg:w-[140px]' },
  { label: 'Check-In', key: 'checkin', width: 'w-[96px] lg:w-[120px]' },
  { label: 'Check-Out', key: 'checkout', width: 'w-[104px] lg:w-[130px]' },
  { label: 'Coordinates', width: 'w-[176px] lg:w-[190px]' },
  { label: 'Status', key: 'status', width: 'w-[136px] lg:w-[160px]' },
  { label: 'Escalation', key: 'escalation', width: 'w-[210px] lg:w-[230px]' },
  { label: 'Attire', key: 'attire', width: 'w-[150px] lg:w-[170px]' },
  { label: 'Photo', width: 'w-[84px] lg:w-[90px]' },
  { label: 'Report', width: 'w-[92px] lg:w-[100px]' },
  { label: 'Remark', width: 'w-[260px] lg:w-[320px]' },
] as const;

const SELECT_COLUMN_WIDTH = 'w-10 lg:w-12';

const RECORD_TABLE_WIDTH = {
  withSelect: 'w-[1900px] lg:w-[2248px]',
  withoutSelect: 'w-[1860px] lg:w-[2200px]',
} as const;

const HEAD_CELL = 'px-3 py-3 lg:p-4';
const CELL = 'px-3 py-2.5 lg:p-4';
const CELL_TEXT = 'text-xs sm:text-sm';

const PINNED_HEAD = 'max-lg:sticky max-lg:left-0 max-lg:z-20 bg-slate-50 max-lg:shadow-[inset_-1px_0_0_rgb(226_232_240)]';
const PINNED_CELL = 'max-lg:sticky max-lg:left-0 max-lg:z-[1] max-lg:shadow-[inset_-1px_0_0_rgb(226_232_240)]';

export default function DailyAttendanceTable({ onRowClick, canBulkDelete = false }: DailyAttendanceTableProps) {
  const today = useMemo(() => localDateValue(), []);
  const toast = useToast();
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [photoTarget, setPhotoTarget] = useState<
    { record: AttendanceRecord; kind: 'checkin' | 'checkout' } | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savedFilters] = useState(() => recordsFiltersFromQuery(window.location.search, today) ?? loadRecordsFilters(undefined, today));
  const [preset, setPreset] = useState<DatePreset>(savedFilters.preset);
  const [range, setRange] = useState<DateRange>(savedFilters.range);
  const [roleFilter, setRoleFilter] = useState(savedFilters.role);
  const [collegeFilter, setCollegeFilter] = useState(savedFilters.college);
  const [statusFilter, setStatusFilter] = useState<AttendanceStatus | ''>(savedFilters.status);
  const [escalationFilter, setEscalationFilter] = useState<EscalationFilter>(savedFilters.escalation);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState(savedFilters.search);
  const [nameFilter, setNameFilter] = useState('');
  const [attireFilter, setAttireFilter] = useState('');
  const [sort, setSort] = useState<ColumnSort | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    const filters = {
      preset,
      range,
      search,
      college: collegeFilter,
      role: roleFilter,
      status: statusFilter,
      escalation: escalationFilter,
    };
    saveRecordsFilters(filters);
    writeQueryParams(recordsFiltersToQuery(filters));
  }, [preset, range, search, collegeFilter, roleFilter, statusFilter, escalationFilter]);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeController: AbortController | null = null;
    let syncCursor: string | null = null;
    let currentRows: AttendanceRecord[] = [];
    const endpoint = attendanceRangePath(range);
    setRecords([]);
    setLoading(true);

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
      const requestStartedAt = new Date().toISOString();
      activeController = controller;
      if (showLoading) setLoading(true);
      let pendingWork = false;
      try {
        const deltaEndpoint = syncCursor
          ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}updated_since=${encodeURIComponent(syncCursor)}`
          : endpoint;
        const data = await apiFetchAllPages<AttendanceRecord>(deltaEndpoint, {
          pageSize: 1_000,
          signal: controller.signal,
        });
        const rows = Array.isArray(data) ? data : [];
        if (syncCursor) {
          const merged = new Map(currentRows.map((row) => [String(row._id), row]));
          for (const row of rows) merged.set(String(row._id), row);
          currentRows = [...merged.values()].sort((left, right) => (
            new Date(right.check_in_time || right.date || 0).getTime()
            - new Date(left.check_in_time || left.date || 0).getTime()
          ));
        } else {
          currentRows = rows;
        }
        currentRows = spreadEscalation(currentRows);
        syncCursor = requestStartedAt;
        pendingWork = currentRows.some(
          (row) => normalizeAttendanceStatus(row.status) === 'pending'
            || ['queued', 'processing', 'outbox_pending'].includes(String(row.checkout_evaluation_queue_status || ''))
        );
        if (!disposed) {
          setRecords(currentRows);
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
  }, [range, reloadVersion]);

  const roles = useMemo(
    () => uniqueRecordValues(records, 'instructor_role', roleFilter),
    [records, roleFilter],
  );
  const colleges = useMemo(
    () => uniqueRecordValues(records, 'college_name', collegeFilter),
    [records, collegeFilter],
  );
  const attireOptions = useMemo(
    () => [...new Set(records.map((record) => record.attire_type).filter((value): value is string => Boolean(value)))]
      .map((value) => ({ value, label: ATTIRE_LABELS[value] || value }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [records],
  );
  const filteredRecords = useMemo(
    () => sortRows(
      filterAttendanceRecords(records, {
        search,
        role: roleFilter,
        college: collegeFilter,
        status: statusFilter,
        escalation: escalationFilter,
      }).filter((record) => (
        textMatches(record.instructor_name, nameFilter)
        && (!attireFilter || record.attire_type === attireFilter)
      )),
      sort,
      (record, key) => {
        switch (key) {
          case 'name': return record.instructor_name;
          case 'role': return record.instructor_role;
          case 'institute': return record.college_name;
          case 'date': return timeValue(record.date || record.check_in_time);
          case 'checkin': return timeValue(record.check_in_time);
          case 'checkout': return timeValue(record.check_out_time);
          case 'status': return normalizeAttendanceStatus(record.status);
          case 'escalation': return record.escalation?.count ?? null;
          case 'attire': return record.attire_type ? ATTIRE_LABELS[record.attire_type] || record.attire_type : null;
          default: return null;
        }
      },
    ),
    [records, search, roleFilter, collegeFilter, statusFilter, escalationFilter, nameFilter, attireFilter, sort],
  );
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const scoped = filterAttendanceRecords(records, {
      search,
      role: roleFilter,
      college: collegeFilter,
      escalation: escalationFilter,
    });
    for (const record of scoped) {
      const key = normalizeAttendanceStatus(record.status);
      counts[key] = (counts[key] || 0) + 1;
    }
    counts[''] = scoped.length;
    return counts;
  }, [records, search, roleFilter, collegeFilter, escalationFilter]);

  const visibleIds = useMemo(
    () => filteredRecords.map((record) => String(record._id)),
    [filteredRecords],
  );
  const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected;
    }
  }, [selectedVisibleCount, allVisibleSelected]);

  const openRecord = (record: AttendanceRecord) => {
    if (canOpenRecord(record.status)) onRowClick(record);
  };

  const emptyRow = (message: string) => (
    <tr>
      <td colSpan={RECORD_COLUMNS.length + (canBulkDelete ? 1 : 0)} className="py-8 lg:p-8 text-slate-400">
        <div className="text-center max-lg:sticky max-lg:left-0 max-lg:w-[calc(100vw-2.25rem)]">{message}</div>
      </td>
    </tr>
  );

  // The filter each column header opens. These are the same filters the phone
  // layout reaches through its Filters panel, so both stay in step.
  const columnFilter = (key: string): { active: boolean; render: (close: () => void) => ReactNode } | null => {
    switch (key) {
      case 'name':
        return {
          active: Boolean(nameFilter.trim()),
          render: (close) => <TextFilter value={nameFilter} onChange={setNameFilter} close={close} placeholder="Name contains…" />,
        };
      case 'role':
        return {
          active: Boolean(roleFilter),
          render: (close) => <OptionsFilter value={roleFilter} options={roles.map((value) => ({ value, label: value }))} onChange={setRoleFilter} close={close} allLabel="All roles" />,
        };
      case 'institute':
        return {
          active: Boolean(collegeFilter),
          render: (close) => <OptionsFilter value={collegeFilter} options={colleges.map((value) => ({ value, label: value }))} onChange={setCollegeFilter} close={close} allLabel="All institutes" />,
        };
      case 'date':
        return {
          active: preset !== 'today',
          render: () => (
            <div className="flex flex-col gap-2 p-1">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Show records for</p>
              <DateRangeFilter preset={preset} range={range} today={today} onChange={handleRangeChange} />
            </div>
          ),
        };
      case 'status':
        return {
          active: Boolean(statusFilter),
          render: (close) => <OptionsFilter value={statusFilter} options={STATUS_FILTER_OPTIONS} onChange={setStatusFilter} close={close} allLabel="All statuses" />,
        };
      case 'escalation':
        return {
          active: Boolean(escalationFilter),
          render: (close) => <OptionsFilter value={escalationFilter} options={ESCALATION_FILTER_OPTIONS} onChange={setEscalationFilter} close={close} allLabel="All instructors" />,
        };
      case 'attire':
        return {
          active: Boolean(attireFilter),
          render: (close) => <OptionsFilter value={attireFilter} options={attireOptions} onChange={setAttireFilter} close={close} allLabel="All attire" />,
        };
      default:
        return null;
    }
  };

  const handleRangeChange = (nextPreset: DatePreset, nextRange: DateRange) => {
    setSelectedIds(new Set());
    setRecords([]);
    setLoading(true);
    setPreset(nextPreset);
    setRange(nextRange);
  };

  const activeFilterCount = (preset !== 'today' ? 1 : 0)
    + (collegeFilter ? 1 : 0)
    + (roleFilter ? 1 : 0)
    + (statusFilter ? 1 : 0)
    + (escalationFilter ? 1 : 0)
    + (nameFilter.trim() ? 1 : 0)
    + (attireFilter ? 1 : 0);

  const closeFilters = useCallback(() => setFiltersOpen(false), []);

  const clearAllFilters = () => {
    setCollegeFilter('');
    setRoleFilter('');
    setStatusFilter('');
    setEscalationFilter('');
    setNameFilter('');
    setAttireFilter('');
    if (preset !== 'today') handleRangeChange('today', rangeForPreset('today', today));
  };

  const toggleRecord = (attendanceId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(attendanceId)) next.delete(attendanceId);
      else next.add(attendanceId);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const deleteSelectedRecords = async () => {
    const attendanceIds = [...selectedIds];
    if (!attendanceIds.length) return;
    setDeleting(true);
    try {
      const result = await apiJson<BulkDeleteResult>('/api/v2/attendance/bulk-delete', {
        method: 'POST',
        body: { attendance_ids: attendanceIds },
        timeoutMs: 120_000,
      });
      const deletedCount = result.deleted_ids?.length || 0;
      const failedCount = result.failed?.length || 0;
      setSelectedIds(new Set());
      setConfirmBulkDelete(false);
      setReloadVersion((current) => current + 1);
      if (deletedCount) {
        toast.success(`${deletedCount} attendance record${deletedCount === 1 ? '' : 's'} deleted`);
      }
      if (failedCount) {
        toast.error(`${failedCount} record${failedCount === 1 ? '' : 's'} could not be deleted`, {
          detail: 'Refresh and retry those records.',
        });
      }
    } catch (deleteError) {
      toast.error('Could not delete the selected records', {
        detail: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="w-full flex flex-col h-full" aria-labelledby="daily-records-title" aria-busy={loading}>
      <h2 id="daily-records-title" className="sr-only">Daily attendance records</h2>
      <div className="mb-4 flex items-center justify-between gap-2 md:mb-5">
        {/* Left: search and Filters. The filters open as a dropdown under this row. */}
        <div className="relative flex min-w-0 flex-1 items-center gap-2">
          <span className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 sm:left-2.5" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search attendance records"
              maxLength={120}
              placeholder="Search name, institute, remarks…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-11 w-full rounded-lg border border-slate-300 bg-white py-0 pl-9 pr-3 text-base font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 sm:h-9 sm:rounded-md sm:pl-8 sm:text-sm"
            />
          </span>
          {/* From md up the filters panel lines up with the Filters button's
              left edge and opens to the right; narrower screens keep it under
              the search row so it cannot run off the right edge. */}
          <div className="shrink-0 md:relative">
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            aria-label={activeFilterCount ? `Filters, ${activeFilterCount} active` : 'Filters'}
            className={`relative flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500/20 sm:h-9 sm:justify-start sm:rounded-md ${
              activeFilterCount
                ? 'border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <SlidersHorizontal size={18} className="sm:size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Filters</span>
            {activeFilterCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-600 px-1.5 text-[11px] font-bold text-white sm:static">
                {activeFilterCount}
              </span>
            )}
          </button>
          <AttendanceFilterDrawer
            open={filtersOpen}
            onClose={closeFilters}
            preset={preset}
            range={range}
            today={today}
            onRangeChange={handleRangeChange}
            college={collegeFilter}
            colleges={colleges}
            onCollegeChange={setCollegeFilter}
            role={roleFilter}
            roles={roles}
            onRoleChange={setRoleFilter}
            status={statusFilter}
            onStatusChange={setStatusFilter}
            escalation={escalationFilter}
            onEscalationChange={setEscalationFilter}
            onClearAll={clearAllFilters}
            matchCount={filteredRecords.length}
          />
          </div>
          {(activeFilterCount > 0 || search) && (
            <button
              type="button"
              onClick={() => {
                clearAllFilters();
                setSearch('');
              }}
              aria-label="Clear filters"
              title="Clear all filters and the search"
              className="flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-700 transition-colors hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-rose-500/20 sm:h-9 sm:justify-start sm:rounded-md"
            >
              <X size={18} className="sm:size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Clear</span>
            </button>
          )}
        </div>

        {/* Right: bulk delete (when rows are selected) and Export. */}
        <div className="flex shrink-0 items-center gap-2">
          {canBulkDelete && selectedIds.size > 0 && (
            <button
              type="button"
              onClick={() => setConfirmBulkDelete(true)}
              aria-label={`Delete selected (${selectedIds.size})`}
              className="flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition-colors hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500/20 sm:h-9 sm:rounded-md"
            >
              <Trash2 size={16} aria-hidden="true" />
              <span className="sm:hidden">{selectedIds.size}</span>
              <span className="hidden sm:inline">Delete selected ({selectedIds.size})</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              downloadAttendanceCsv(filteredRecords, range).catch((exportError) => {
                toast.error('Could not export the records', {
                  detail: exportError instanceof Error ? exportError.message : String(exportError),
                });
              });
            }}
            disabled={loading || filteredRecords.length === 0}
            title={filteredRecords.length ? `Download ${filteredRecords.length} records as CSV` : 'Nothing to export'}
            aria-label="Export"
            className="flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50 sm:h-9 sm:justify-start sm:rounded-md"
          >
            <Download size={18} className="sm:size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Export</span>
          </button>
        </div>
      </div>

      {error && <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}

      <div className="lg:hidden">
        <div className="-mx-4 mb-2 flex gap-2 overflow-x-auto overscroll-x-contain px-4 pb-1 [scrollbar-width:none]" role="group" aria-label="Date range">
          {MOBILE_DATE_CHIPS.map((chip) => {
            const active = preset === chip.value;
            return (
              <button
                key={chip.value}
                type="button"
                aria-pressed={active}
                onClick={() => { if (!active) handleRangeChange(chip.value, rangeForPreset(chip.value, today)); }}
                className={`flex h-9 shrink-0 items-center rounded-full border px-3.5 text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700'
                }`}
              >
                {chip.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            aria-pressed={!MOBILE_DATE_CHIPS.some((chip) => chip.value === preset)}
            className={`flex h-9 shrink-0 items-center rounded-full border px-3.5 text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
              MOBILE_DATE_CHIPS.some((chip) => chip.value === preset) ? 'border-slate-200 bg-white text-slate-700' : 'border-slate-900 bg-slate-900 text-white'
            }`}
          >
            Pick dates
          </button>
        </div>
        <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto overscroll-x-contain px-4 pb-1 [scrollbar-width:none]" role="group" aria-label="Result">
          {MOBILE_STATUS_CHIPS.map((chip) => {
            const active = statusFilter === chip.value;
            return (
              <button
                key={chip.value || 'all'}
                type="button"
                aria-pressed={active}
                onClick={() => setStatusFilter(chip.value)}
                className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  active ? chip.active : 'border-slate-200 bg-white text-slate-700'
                }`}
              >
                {chip.label}
                <span className={active ? '' : 'text-slate-500'}>{statusCounts[chip.value] || 0}</span>
              </button>
            );
          })}
        </div>
        {loading && records.length === 0 ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm font-medium text-slate-500" role="status">Loading records…</p>
        ) : filteredRecords.length === 0 ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm font-medium text-slate-500">No records match these filters.</p>
        ) : (
          <ul className="flex flex-col gap-2.5 pb-2" aria-label="Attendance records">
            {filteredRecords.map((record) => (
              <MobileRecordItem key={String(record._id)} record={record} today={today} onOpen={openRecord} />
            ))}
          </ul>
        )}
      </div>

      <div className="hidden lg:flex bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden flex-1 flex-col">
        <div className="overflow-x-auto flex-1 max-lg:overscroll-x-contain">
          <table className={`text-left border-collapse table-fixed max-w-none ${canBulkDelete ? RECORD_TABLE_WIDTH.withSelect : RECORD_TABLE_WIDTH.withoutSelect}`}>
            <thead className="sticky top-0 bg-slate-50 z-10 shadow-sm">
              <tr className="border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                {canBulkDelete && (
                  <th className={`${SELECT_COLUMN_WIDTH} ${HEAD_CELL}`}>
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allVisibleSelected}
                      disabled={!visibleIds.length}
                      onChange={toggleAllVisible}
                      aria-label="Select all visible attendance records"
                      className="h-4 w-4 max-lg:h-5 max-lg:w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  </th>
                )}
                {RECORD_COLUMNS.map((column, index) => {
                  const key = 'key' in column ? column.key : undefined;
                  const filter = key ? columnFilter(key) : null;
                  const sorted = Boolean(key) && sort?.key === key;
                  return (
                    <th
                      key={column.label}
                      scope="col"
                      aria-sort={sorted ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                      className={`${HEAD_CELL} ${column.width} ${index === 0 ? PINNED_HEAD : ''}`}
                    >
                      <ColumnHeader
                        label={column.label}
                        sortKey={key}
                        sort={sort}
                        onSort={(nextKey) => setSort((current) => nextColumnSort(current, nextKey))}
                        filterActive={filter?.active}
                        filter={filter?.render}
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && records.length === 0 ? (
                emptyRow('Loading attendance records…')
              ) : records.length === 0 ? (
                emptyRow('No attendance records found for the selected dates.')
              ) : filteredRecords.length === 0 ? (
                emptyRow('No records match the selected filters.')
              ) : filteredRecords.map((record) => {
                const canOpen = canOpenRecord(record.status);
                const attendanceId = String(record._id);
                const selected = selectedIds.has(attendanceId);
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
                    className={`group transition-colors ${selected ? 'bg-indigo-50/70 max-lg:bg-indigo-50' : ''} ${canOpen ? 'hover:bg-slate-50 cursor-pointer focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500' : 'opacity-80'}`}
                  >
                    {canBulkDelete && (
                      <td className={`${SELECT_COLUMN_WIDTH} ${CELL}`} onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleRecord(attendanceId)}
                          aria-label={`Select attendance record for ${record.instructor_name || 'instructor'}`}
                          className="h-4 w-4 max-lg:h-5 max-lg:w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                      </td>
                    )}
                    <td className={`${CELL} ${PINNED_CELL} ${selected ? 'max-lg:bg-indigo-50' : 'max-lg:bg-white'} ${canOpen && !selected ? 'max-lg:group-hover:bg-slate-50' : ''} font-bold text-slate-800 truncate max-lg:text-sm`} title={record.instructor_name || ''}>{record.instructor_name}</td>
                    <td className={`${CELL} ${CELL_TEXT} font-medium text-slate-500 truncate`} title={record.instructor_role || ''}>{record.instructor_role || '--'}</td>
                    <td className={`${CELL} ${CELL_TEXT} font-medium text-slate-600 truncate`} title={record.college_name || ''}>{record.college_name || 'Unknown'}</td>
                    <td className={`${CELL} ${CELL_TEXT} font-medium text-slate-600 whitespace-nowrap`}>
                      {attendanceSessionDateLabel(record.check_in_time, record.check_out_time, record.date)}
                    </td>
                    <td className={`${CELL} ${CELL_TEXT} font-bold text-slate-700 whitespace-nowrap`}>{formatAttendanceTime(record.check_in_time)}</td>
                    <td className={`${CELL} ${CELL_TEXT} font-bold text-slate-700 whitespace-nowrap`}>
                      {checkoutDateTimeLabel(record.check_in_time, record.check_out_time, record.checkout_status)}
                    </td>
                    <td className={`${CELL} ${CELL_TEXT} text-slate-500 truncate`}>
                      {record.location_coordinates ? (
                        <span className="flex items-center gap-1.5 text-indigo-600 font-medium whitespace-nowrap" title="Latitude, longitude">
                          <MapPin size={14} className="shrink-0" aria-hidden="true" /> {formatCoordinates(record.location_coordinates)}
                        </span>
                      ) : '--'}
                    </td>
                    <td className={`${CELL} whitespace-nowrap`}><StatusBadge status={record.status} /></td>
                    <td className={`${CELL} whitespace-nowrap`}><EscalationTag escalation={record.escalation} today={today} /></td>
                    <td className={`${CELL} whitespace-nowrap`}><AttireTag attire={record.attire_type} /></td>
                    <td className={CELL}>
                      <div className="flex items-center gap-1.5 whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                        {record.check_in_photo_key ? (
                          <button
                            type="button"
                            title="View check-in photo"
                            aria-label={`View check-in photo for ${record.instructor_name}`}
                            onClick={() => setPhotoTarget({ record, kind: 'checkin' })}
                            className="rounded-md border border-indigo-100 bg-indigo-50 p-1.5 max-lg:p-2 text-indigo-700 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
                            className="rounded-md border border-rose-100 bg-rose-50 p-1.5 max-lg:p-2 text-rose-700 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500"
                          >
                            <LogOut size={15} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className={CELL}>
                      <div className="flex items-center gap-1.5 whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                        {record.report_token ? (
                          <>
                            <a
                              href={publicDayReportPath(record.report_token, localDateValue(new Date(record.date || record.check_in_time || Date.now())), 'checkin')}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open the check-in report"
                              aria-label={`Open the check-in report for ${record.instructor_name}`}
                              className="inline-flex rounded-md border border-indigo-100 bg-indigo-50 p-1.5 max-lg:p-2 text-indigo-700 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            >
                              <FileText size={15} aria-hidden="true" />
                            </a>
                            {record.check_out_time ? (
                              <a
                                href={publicDayReportPath(record.report_token, localDateValue(new Date(record.date || record.check_in_time || Date.now())), 'checkout')}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Open the check-out report"
                                aria-label={`Open the check-out report for ${record.instructor_name}`}
                                className="inline-flex rounded-md border border-rose-100 bg-rose-50 p-1.5 max-lg:p-2 text-rose-700 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500"
                              >
                                <FileText size={15} aria-hidden="true" />
                              </a>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-xs text-slate-300">--</span>
                        )}
                      </div>
                    </td>
                    <td className={`${CELL} ${CELL_TEXT} text-slate-500 truncate`} title={record.remarks || ''}>{record.remarks || '--'}</td>
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
          subtitle={formatAttendanceTime(
            photoTarget.kind === 'checkin'
              ? photoTarget.record.check_in_time
              : photoTarget.record.check_out_time,
          )}
          onClose={() => setPhotoTarget(null)}
        />
      )}

      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete selected attendance records?"
        message={`This permanently deletes ${selectedIds.size} selected attendance record${selectedIds.size === 1 ? '' : 's'}.`}
        detail="Their check-ins, check-outs, appearance reports and stored photographs will be removed. This cannot be undone."
        confirmLabel="Delete selected"
        destructive
        busy={deleting}
        onConfirm={() => void deleteSelectedRecords()}
        onCancel={() => setConfirmBulkDelete(false)}
      />
    </section>
  );
}
