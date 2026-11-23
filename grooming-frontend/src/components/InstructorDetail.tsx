import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronLeft, Clock, Calendar, CheckCircle2, XCircle, TriangleAlert, CircleAlert, LogIn, LogOut, RefreshCw, Trash2 } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import ConfirmDialog from './ConfirmDialog';
import PhotoViewer from './PhotoViewer';
import AttendancePhotoCircle from './AttendancePhotoCircle';
import { useToast } from './useToast';
import { normalizeAttendanceStatus } from '../status';
import { formatAttendanceDate, formatAttendanceTime } from '../attendanceFilters';
import GroomingReport from './GroomingReport';
import RowActionsMenu, { type RowAction } from './RowActionsMenu';
import { improvementTipsFor, isUnassessed, reportTables } from '../reportLayout';
import LocationPanel from './LocationPanel';
import { readQueryParam, writeQueryParams } from '../routes';
import type { AttendanceRecord, Evaluation } from '../types';
import {
  aiRemarksForHalf,
  beginReportLoad,
  evaluationForHalf,
  reportPanelStateForHalf,
  type ReportHalf,
  type ReportPanelStates,
} from '../reportSelection';

interface ReportStatusPayload {
  attendance_id: string;
  status: string;
  compliance_status: string | null;
  remarks: string | null;
  queue_status: string | null;
  settled: boolean;
}

function reportQuery(half: ReportHalf): string {
  return half === 'checkout' ? '?kind=checkout' : '';
}

async function fetchStoredEvaluation(
  attendanceId: string,
  half: ReportHalf,
  signal: AbortSignal,
): Promise<Evaluation | null> {
  try {
    return await apiFetch<Evaluation | null>(
      `/api/v2/attendance/${encodeURIComponent(attendanceId)}/evaluation${reportQuery(half)}`,
      { signal },
    );
  } catch (requestError) {
    if ((requestError as { status?: number })?.status === 404) return null;
    throw requestError;
  }
}

function applyReportStatus(
  record: AttendanceRecord | null,
  attendanceId: string,
  half: ReportHalf,
  status: ReportStatusPayload,
): AttendanceRecord | null {
  if (!record || String(record._id) !== attendanceId) return record;
  if (half === 'checkout') {
    return {
      ...record,
      checkout_compliance_status: status.compliance_status || status.status,
      checkout_remarks: status.remarks,
      checkout_evaluation_queue_status: status.queue_status,
    };
  }
  return {
    ...record,
    status: status.status,
    remarks: status.remarks,
    evaluation_queue_status: status.queue_status,
  };
}

interface InstructorDetailProps {
  record: AttendanceRecord | null;
  onBack: () => void;
  canDelete?: boolean;
  canDeleteCheckout?: boolean;
  canReanalyse?: boolean;
  onDeleted?: (attendanceId: string) => void;
}

function StatusBadge({ status }: { status?: string }) {
  switch (normalizeAttendanceStatus(status)) {
    case 'compliant':
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-emerald-50 text-emerald-600 border border-emerald-200"><CheckCircle2 size={16} aria-hidden="true" /> Compliant</span>;
    case 'non_compliant':
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-rose-50 text-rose-600 border border-rose-200"><XCircle size={16} aria-hidden="true" /> Non-compliant</span>;
    case 'unassessed':
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-amber-50 text-amber-700 border border-amber-200"><CircleAlert size={16} aria-hidden="true" /> Not assessed</span>;
    case 'error':
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-slate-100 text-slate-600 border border-slate-200"><TriangleAlert size={16} aria-hidden="true" /> Analysis error</span>;
    default:
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-amber-50 text-amber-600 border border-amber-200"><Clock size={16} aria-hidden="true" /> Pending AI</span>;
  }
}

const VERDICT_TONES = {
  non_compliant: { frame: 'border-rose-200 bg-rose-50', headline: 'text-rose-900', detail: 'text-rose-800' },
  compliant: { frame: 'border-emerald-200 bg-emerald-50', headline: 'text-emerald-900', detail: 'text-emerald-800' },
  unassessed: { frame: 'border-amber-200 bg-amber-50', headline: 'text-amber-900', detail: 'text-amber-800' },
  pending: { frame: 'border-indigo-100 bg-indigo-50', headline: 'text-indigo-900', detail: 'text-indigo-800' },
  error: { frame: 'border-slate-200 bg-slate-50', headline: 'text-slate-900', detail: 'text-slate-600' },
} as const;

const ATTIRE_LABELS: Record<string, string> = {
  FORMAL: 'Formal',
  SAREE: 'Saree',
  KURTI_WITH_DUPATTA: 'Kurti with dupatta',
  ABAYA: 'Abaya',
  KURTA_PAJAMA: 'Kurta with payjama',
};

function verdictHeadline(status: ReturnType<typeof normalizeAttendanceStatus>, fixCount: number): string {
  if (status === 'non_compliant') {
    return fixCount > 0 ? `${fixCount} thing${fixCount === 1 ? '' : 's'} to fix` : 'Did not meet the standard';
  }
  if (status === 'compliant') return 'All checks passed';
  if (status === 'unassessed') return 'Not assessed';
  if (status === 'error') return 'The analysis did not complete';
  return 'Analysing the photo…';
}

export default function InstructorDetail({ record, onBack, canDelete, canDeleteCheckout, canReanalyse = false, onDeleted }: InstructorDetailProps) {
  const [freshRecord, setFreshRecord] = useState<AttendanceRecord | null>(record);
  const [reportStates, setReportStates] = useState<ReportPanelStates>({});
  const [photoKind, setPhotoKind] = useState<'checkin' | 'checkout' | null>(null);
  const [tab, setTab] = useState<'checkin' | 'checkout'>(() => (readQueryParam('half') === 'checkout' ? 'checkout' : 'checkin'));
  const [confirmDelete, setConfirmDelete] = useState<'record' | 'checkout' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reanalysing, setReanalysing] = useState(false);
  const [queuedHalf, setQueuedHalf] = useState<ReportHalf | null>(null);
  const toast = useToast();
  const displayRecord = freshRecord || record;
  const attendanceId = record ? String(record._id) : null;
  useEffect(() => {
    writeQueryParams({ half: tab === 'checkout' ? 'checkout' : null });
  }, [tab]);

  const reportState = reportPanelStateForHalf(reportStates, attendanceId, tab);
  const evaluation = evaluationForHalf(reportState, attendanceId, tab);
  const loading = !reportState || reportState.loading;
  const error = reportState?.error || '';

  useEffect(() => {
    setFreshRecord(record);
  }, [record]);

  const queueStatus = tab === 'checkout'
    ? displayRecord?.checkout_evaluation_queue_status
    : displayRecord?.evaluation_queue_status;
  const analysisFailed = queueStatus === 'failed';
  const analysisRunning = !analysisFailed && !evaluation
    && (queuedHalf === tab
      || reportState?.settled === false
      || queueStatus === 'queued'
      || queueStatus === 'processing');
  const shouldPoll = queuedHalf === tab || reportState?.settled === false;
  const halfHasPhoto = Boolean(tab === 'checkout' ? displayRecord?.check_out_photo_key : displayRecord?.check_in_photo_key);
  const reanalyseOffered = canReanalyse && halfHasPhoto;

  const handleReanalyse = async () => {
    if (!record) return;
    setReanalysing(true);
    try {
      const query = reportQuery(tab);
      await apiJson(
        `/api/v2/attendance/${encodeURIComponent(String(record._id))}/reanalyse${query}`,
        { method: 'POST', timeoutMs: tab === 'checkout' ? 150_000 : undefined },
      );
      if (tab === 'checkout') {
        const updated = await apiFetch<Evaluation>(
          `/api/v2/attendance/${encodeURIComponent(String(record._id))}/evaluation?kind=checkout`,
        );
        setReportStates((current) => ({
          ...current,
          checkout: {
            attendanceId: String(record._id),
            half: 'checkout',
            evaluation: updated || null,
            loading: false,
            error: '',
            settled: true,
          },
        }));
        setQueuedHalf(null);
        toast.success('Analysis completed', { detail: 'The checkout report has been updated.' });
      } else {
        toast.success('Analysis queued', { detail: 'The report appears here once it finishes.' });
        setQueuedHalf('checkin');
      }
    } catch (error) {
      toast.error(tab === 'checkout' ? 'Could not complete the analysis' : 'Could not queue the analysis', {
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setReanalysing(false);
    }
  };

  const handleDelete = async () => {
    if (!record) return;
    setDeleting(true);
    try {
      await apiJson(`/api/v2/attendance/${encodeURIComponent(String(record._id))}`, {
        method: 'DELETE',
      });
      toast.success('Attendance record deleted', {
        detail: `${record.instructor_name || 'The record'} and its photos have been removed.`,
      });
      setConfirmDelete(null);
      onDeleted?.(String(record._id));
      onBack();
    } catch (deleteError) {
      toast.error('Could not delete the record', {
        detail: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
      setDeleting(false);
    }
  };

  const handleDeleteCheckout = async () => {
    if (!record) return;
    setDeleting(true);
    try {
      await apiJson(`/api/v2/attendance/${encodeURIComponent(String(record._id))}/check-out`, {
        method: 'DELETE',
      });
      toast.success('Check-out deleted', {
        detail: 'The check-in and its report are unchanged.',
      });
      setConfirmDelete(null);
      onDeleted?.(String(record._id));
      onBack();
    } catch (deleteError) {
      toast.error('Could not delete the check-out', {
        detail: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
      setDeleting(false);
    }
  };

  useEffect(() => {
    if (!attendanceId) return undefined;
    const controller = new AbortController();
    setReportStates((current) => beginReportLoad(current, attendanceId, tab));

    const load = async () => {
      try {
        const [status, storedEvaluation] = await Promise.all([
          apiFetch<ReportStatusPayload>(
            `/api/v2/attendance/${encodeURIComponent(attendanceId)}/status${reportQuery(tab)}`,
            { signal: controller.signal },
          ),
          fetchStoredEvaluation(attendanceId, tab, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setFreshRecord((current) => applyReportStatus(current, attendanceId, tab, status));
        setReportStates((current) => ({
          ...current,
          [tab]: {
            attendanceId,
            half: tab,
            evaluation: storedEvaluation,
            loading: false,
            error: '',
            settled: status.settled,
          },
        }));
        if (status.settled) {
          setQueuedHalf((current) => (current === tab ? null : current));
        }
      } catch (requestError) {
        if (controller.signal.aborted) return;
        const status = (requestError as { status?: number })?.status;
        if (status === 401) return;
        setReportStates((current) => {
          const cached = reportPanelStateForHalf(current, attendanceId, tab);
          if (cached && !cached.loading) return current;
          return {
            ...current,
            [tab]: {
              attendanceId,
              half: tab,
              evaluation: null,
              loading: false,
              error: requestError instanceof Error ? requestError.message : String(requestError),
              settled: null,
            },
          };
        });
      }
    };

    void load();
    return () => controller.abort();
  }, [attendanceId, tab]);

  useEffect(() => {
    if (!attendanceId || !shouldPoll) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof window.setTimeout> | undefined;

    const poll = async () => {
      try {
        const status = await apiFetch<ReportStatusPayload>(
          `/api/v2/attendance/${encodeURIComponent(attendanceId)}/status${reportQuery(tab)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setFreshRecord((current) => applyReportStatus(current, attendanceId, tab, status));

        if (status.settled) {
          const storedEvaluation = await fetchStoredEvaluation(attendanceId, tab, controller.signal);
          if (controller.signal.aborted) return;
          setReportStates((current) => ({
            ...current,
            [tab]: {
              attendanceId,
              half: tab,
              evaluation: storedEvaluation,
              loading: false,
              error: '',
              settled: true,
            },
          }));
          setQueuedHalf((current) => (current === tab ? null : current));
          return;
        }

        setReportStates((current) => {
          const existing = reportPanelStateForHalf(current, attendanceId, tab);
          return {
            ...current,
            [tab]: {
              attendanceId,
              half: tab,
              evaluation: existing?.evaluation || null,
              loading: false,
              error: '',
              settled: false,
            },
          };
        });
      } catch {
      }

      if (!controller.signal.aborted) timer = window.setTimeout(poll, 3000);
    };

    timer = window.setTimeout(poll, 3000);
    return () => {
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [attendanceId, shouldPoll, tab]);

  if (!record) {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-8 text-center">
        <p className="text-sm text-slate-500">Choose a completed attendance record to view its report.</p>
        <button type="button" onClick={onBack} className="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-sm font-bold text-white">Back to records</button>
      </div>
    );
  }

  const halfStatus = normalizeAttendanceStatus(tab === 'checkout'
    ? (evaluation?.overall_status
      || displayRecord?.checkout_compliance_status
      || (displayRecord?.check_out_photo_key ? 'pending' : undefined))
    : (evaluation?.overall_status || displayRecord?.status));
  const fixTips = evaluation && !isUnassessed(evaluation) ? improvementTipsFor(evaluation) : [];
  const failedChecks = evaluation
    ? reportTables(evaluation).reduce((sum, table) => sum + table.items.filter((item) => String(item.status).toUpperCase() === 'FAIL').length, 0)
    : 0;
  const verdictTone = VERDICT_TONES[halfStatus] || VERDICT_TONES.pending;
  const attireLabel = ATTIRE_LABELS[String(evaluation?.attire_type || (tab === 'checkin' ? displayRecord?.attire_type : '') || '')] || '';
  const mobileActions: RowAction[] = [
    ...(tab === 'checkout' && canDeleteCheckout && record.check_out_time
      ? [{ key: 'delete-checkout', label: 'Delete check-out', icon: 'delete' as const, destructive: true, onSelect: () => setConfirmDelete('checkout') }]
      : []),
    ...(canDelete
      ? [{ key: 'delete-record', label: tab === 'checkin' ? 'Delete check-in' : 'Delete record', icon: 'delete' as const, destructive: true, onSelect: () => setConfirmDelete('record') }]
      : []),
  ];
  const sessionDay = formatAttendanceDate(record.check_in_time || record.date);

  return (
    <section className="w-full flex flex-col h-full animate-in fade-in slide-in-from-right-4 duration-300" aria-labelledby="instructor-detail-title">
      <div className="-mx-1 mb-3 flex shrink-0 items-center gap-1.5 lg:hidden">
        <button type="button" aria-label="Back to records" onClick={onBack} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-900 transition-colors hover:bg-slate-100">
          <ChevronLeft size={22} aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-extrabold text-slate-900">{record.instructor_name || 'Instructor'}</p>
          <p className="truncate text-[13px] text-slate-500">{[sessionDay, record.college_name].filter(Boolean).join(' · ')}</p>
        </div>
        {mobileActions.length > 0 && <RowActionsMenu label={`Actions for ${record.instructor_name || 'this record'}`} actions={mobileActions} />}
      </div>

      <div className="mb-6 hidden shrink-0 flex-wrap items-center gap-3 sm:gap-4 lg:flex">
        <button type="button" aria-label="Back to daily records" onClick={onBack} className="p-2 bg-white border border-slate-200 rounded-md hover:bg-slate-50 text-slate-600 transition-colors shadow-sm">
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h2 id="instructor-detail-title" className="text-xl sm:text-2xl font-extrabold text-slate-800">Instructor Detail View</h2>

        <div className="ml-auto flex items-center gap-2">
          {tab === 'checkout' && canDeleteCheckout && record.check_out_time && (
            <button
              type="button"
              onClick={() => setConfirmDelete('checkout')}
              title="Delete only the check-out"
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700 transition-colors hover:bg-amber-100"
            >
              <Trash2 size={14} aria-hidden="true" />
              <span className="hidden sm:inline">Delete check-out</span>
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={() => setConfirmDelete('record')}
              title="Delete the whole attendance record"
              className="inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700 transition-colors hover:bg-rose-100"
            >
              <Trash2 size={14} aria-hidden="true" />
              <span className="hidden sm:inline">
                {tab === 'checkin' ? 'Delete check-in' : 'Delete record'}
              </span>
            </button>
          )}
        </div>
      </div>

      <div role="tablist" aria-label="Attendance report" className="mb-3 flex shrink-0 gap-1 rounded-[14px] bg-indigo-50 p-1 lg:mb-4 lg:w-fit lg:rounded-md lg:border lg:border-slate-200 lg:bg-white">
        {([
          { key: 'checkin', label: 'Check-in report', short: 'Check-in', time: record.check_in_time, Icon: LogIn },
          { key: 'checkout', label: 'Check-out report', short: 'Check-out', time: record.check_out_time, Icon: LogOut },
        ] as const).map(({ key, label, short, time, Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-[10px] px-3 py-2 text-sm font-bold transition-colors lg:min-h-0 lg:flex-none lg:rounded-md ${
              tab === key
                ? 'bg-white text-indigo-900 shadow-[0_1px_3px_rgba(15,23,42,0.08)] lg:bg-indigo-600 lg:text-white lg:shadow-sm'
                : 'font-semibold text-indigo-700 lg:font-bold lg:text-slate-600 lg:hover:bg-slate-50'
            }`}
          >
            <Icon size={15} className="hidden lg:block" aria-hidden="true" />
            <span className="lg:hidden">{short} · {time ? formatAttendanceTime(time) : '—'}</span>
            <span className="hidden lg:inline">{label}</span>
          </button>
        ))}
      </div>

      {tab === 'checkout' && !record.check_out_time ? (
        <div className="flex flex-1 min-h-0 items-start justify-center overflow-y-auto lg:items-center">
          <div className="w-full max-w-lg rounded-md border border-dashed border-slate-300 bg-white p-6 sm:p-10 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-500">
              <LogOut size={26} aria-hidden="true" />
            </div>
            <h3 className="text-base sm:text-lg font-extrabold text-slate-800">No check-out recorded</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-500">
              {record.instructor_name || 'This instructor'} checked in at {formatAttendanceTime(record.check_in_time)} on{' '}
              {formatAttendanceDate(record.date)} and has not checked out. Please follow up with them.
            </p>
            <p className="mt-4 text-xs font-medium text-slate-400">
              The check-out time, location and photo appear here once they do.
            </p>
            <button
              type="button"
              onClick={() => setTab('checkin')}
              className="mt-5 inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-bold text-indigo-700 transition-colors hover:bg-indigo-100"
            >
              <LogIn size={15} aria-hidden="true" />
              View the check-in report
            </button>
          </div>
        </div>
      ) : (
      <div className="flex flex-col lg:flex-row gap-3 lg:gap-6 flex-1 min-h-0 lg:overflow-hidden">
        <div className="flex flex-col gap-3 lg:hidden">
          <section aria-label="Result" className={`flex items-center gap-3 rounded-[18px] border p-3 ${verdictTone.frame}`}>
            <AttendancePhotoCircle
              attendanceId={String(record._id)}
              kind={tab}
              hasPhoto={halfHasPhoto}
              label={tab === 'checkin' ? 'Check-in' : 'Check-out'}
              onOpen={() => setPhotoKind(tab)}
            />
            <div className="min-w-0 flex-1">
              <StatusBadge status={halfStatus} />
              <p className={`mt-2 text-base font-extrabold ${verdictTone.headline}`}>
                {verdictHeadline(halfStatus, fixTips.length || failedChecks)}
              </p>
              {attireLabel && <p className={`mt-0.5 text-[13px] ${verdictTone.detail}`}>{attireLabel}</p>}
            </div>
          </section>
          {fixTips.length > 0 && (
            <section aria-labelledby="what-to-fix-title" className="rounded-[18px] border border-slate-200 bg-white px-4 py-3.5">
              <h3 id="what-to-fix-title" className="mb-2.5 text-[15px] font-bold text-slate-900">What to fix</h3>
              <ol className="flex flex-col gap-2.5">
                {fixTips.map((tip, index) => (
                  <li key={tip} className="flex gap-2.5 text-sm leading-snug text-slate-800">
                    <span aria-hidden="true" className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-rose-50 text-xs font-extrabold text-rose-700">{index + 1}</span>
                    {tip}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
        <div className="w-full lg:w-1/3 flex flex-col gap-3 sm:gap-6 lg:overflow-y-auto lg:pb-6 lg:pr-2 max-lg:order-last">
          <div className="hidden lg:flex bg-white rounded-md shadow-sm border border-slate-200 p-5 sm:p-8 flex-col items-center text-center shrink-0">
            <AttendancePhotoCircle
              attendanceId={String(record._id)}
              kind={tab}
              hasPhoto={Boolean(tab === 'checkin' ? record.check_in_photo_key : record.check_out_photo_key)}
              label={tab === 'checkin' ? 'Check-in' : 'Check-out'}
              onOpen={() => setPhotoKind(tab)}
            />
            <h3 className="mt-4 text-xl sm:text-2xl font-extrabold text-slate-800">{record.instructor_name}</h3>
            <p className="text-xs sm:text-sm font-bold text-slate-400 uppercase tracking-widest mt-1.5 mb-4 sm:mb-5">{record.instructor_role}</p>
            <StatusBadge
              status={tab === 'checkout'
                ? (evaluation?.overall_status
                  || displayRecord?.checkout_compliance_status
                  || (displayRecord?.check_out_photo_key ? 'pending' : undefined))
                : (evaluation?.overall_status || displayRecord?.status)}
            />
            {tab === 'checkout' && !record.check_out_photo_key && (
              <p className="mt-4 text-xs font-medium text-slate-400">No photo was taken at check-out.</p>
            )}
          </div>

          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-5 sm:p-6 space-y-5 shrink-0">
            <h4 className="text-sm font-bold text-slate-800 border-b border-slate-100 pb-3">Session Details</h4>
            <div className="flex items-start gap-4"><div className="bg-slate-50 p-2 rounded-md text-slate-400"><Calendar size={18} aria-hidden="true" /></div><div><p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Date</p><p className="text-sm font-semibold text-slate-700">{formatAttendanceDate(tab === 'checkout' ? record.check_out_time : (record.check_in_time || record.date))}</p></div></div>
            <div className="flex items-start gap-4">
              <div className="bg-indigo-50 text-indigo-600 p-2 rounded-md"><Clock size={18} aria-hidden="true" /></div>
              <div>
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">
                  {tab === 'checkin' ? 'Check-in time' : 'Check-out time'}
                </p>
                <p className="text-sm font-semibold text-slate-800">
                  {formatAttendanceTime(tab === 'checkin' ? record.check_in_time : record.check_out_time)}
                </p>
              </div>
            </div>
            <div>
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                {tab === 'checkin' ? 'Check-in location' : 'Check-out location'}
              </p>
              {tab === 'checkout' && !record.check_out_coordinates ? (
                <p className="rounded-md border border-dashed border-slate-200 bg-slate-50 p-3 text-xs font-medium text-slate-400">
                  No location was captured at check-out.
                </p>
              ) : (
                <LocationPanel
                  coordinates={tab === 'checkin' ? record.location_coordinates : record.check_out_coordinates}
                  address={tab === 'checkin' ? record.location_address : record.check_out_location_address}
                  accuracyMetres={tab === 'checkin' ? record.location_accuracy_m : displayRecord?.check_out_location_accuracy_m}
                />
              )}
            </div>
          </div>

          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-5 sm:p-6 shrink-0">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3 mb-4">
              <h4 className="text-sm font-bold text-slate-800">AI Remarks Summary</h4>
              {reanalyseOffered && (
                <button
                  type="button"
                  onClick={() => void handleReanalyse()}
                  disabled={reanalysing}
                  aria-label={`Re-analyse the ${tab === 'checkout' ? 'check-out' : 'check-in'} photo`}
                  className="inline-flex shrink-0 items-center gap-1.5 text-xs font-bold text-indigo-600 transition-colors hover:text-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw size={13} className={reanalysing ? 'animate-spin' : ''} aria-hidden="true" />
                  {reanalysing ? (tab === 'checkout' ? 'Analysing…' : 'Queueing…') : 'Re-analyse'}
                </button>
              )}
            </div>
            <p className="text-sm text-slate-600 leading-relaxed bg-slate-50 p-4 rounded-md border border-slate-100">
              {aiRemarksForHalf(tab, displayRecord, evaluation) || 'No remarks available.'}
            </p>
          </div>
        </div>

        <div className="w-full lg:w-2/3 bg-white rounded-[18px] lg:rounded-md lg:shadow-sm border border-slate-200 p-4 sm:p-6 lg:p-8 lg:overflow-y-auto flex flex-col lg:mb-6">
          <h3 className="mb-3 text-[15px] font-bold text-slate-900 lg:mb-6 lg:border-b lg:border-slate-100 lg:pb-4 lg:text-lg lg:font-extrabold lg:text-slate-800">
            <span className="lg:hidden">All checks</span>
            <span className="hidden lg:inline">Detailed Appearance Report</span>
          </h3>
          {loading ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-4" role="status"><div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" /><p className="text-sm font-medium">Fetching detailed evaluation…</p></div>
          ) : error ? (
            <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">{error}</div>
          ) : !evaluation ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-500 font-medium bg-slate-50 rounded-md border border-dashed border-slate-200 p-8 text-center gap-2">
              {tab === 'checkout' && !record.check_out_photo_key ? (
                <>
                  <XCircle size={32} className="text-slate-300" aria-hidden="true" />
                  <p>No photo was taken at check-out, so there was nothing to assess.</p>
                </>
              ) : analysisRunning ? (
                <>
                  <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" aria-hidden="true" />
                  <p>Analysing the photo. This usually takes a few seconds.</p>
                  <p className="text-xs font-normal text-slate-400">
                    The report appears here once it finishes.
                  </p>
                </>
              ) : (
                <>
                  <XCircle size={32} className="text-slate-300" aria-hidden="true" />
                  <p>
                    {analysisFailed
                      ? `The analysis of this ${tab === 'checkout' ? 'check-out' : 'check-in'} photo did not complete.`
                      : `No appearance report was produced for this ${tab === 'checkout' ? 'check-out' : 'check-in'}.`}
                  </p>
                  {reanalyseOffered && (
                    <button
                      type="button"
                      onClick={() => void handleReanalyse()}
                      disabled={reanalysing}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-bold text-indigo-700 transition-colors hover:bg-indigo-100 disabled:opacity-50"
                    >
                      <RefreshCw size={15} className={reanalysing ? 'animate-spin' : ''} aria-hidden="true" />
                      {reanalysing ? (tab === 'checkout' ? 'Analysing…' : 'Queueing…') : 'Analyse this photo'}
                    </button>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="flex-1 lg:pb-4">
              {evaluation.image_quality === 'RETAKE_RECOMMENDED' && (
                <div role="note" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900 lg:mb-6 lg:rounded-md">
                  <div className="flex items-start gap-3">
                    <CircleAlert size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <div>
                      <h4 className="text-sm font-extrabold">Retake recommended</h4>
                      <p className="mt-1 text-sm leading-relaxed">
                        The framing, lighting or resolution prevented some checkpoints from being
                        assessed. A clearer full-body photo next time will cover them.
                      </p>
                    </div>
                  </div>
                </div>
              )}
              <GroomingReport evaluation={evaluation} tipsShownSeparately />
            </div>
          )}
        </div>
      </div>
      )}

      {photoKind && record && (
        <PhotoViewer
          attendanceId={String(record._id)}
          kind={photoKind}
          title={record.instructor_name || 'Attendance photo'}
          subtitle={`${photoKind === 'checkin' ? 'Check-in' : 'Check-out'} · ${formatAttendanceDate(photoKind === 'checkout' ? record.check_out_time : (record.check_in_time || record.date))}`}
          onClose={() => setPhotoKind(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete === 'record'}
        destructive
        busy={deleting}
        title="Delete this attendance record?"
        message={`This removes the check-in for ${record?.instructor_name || 'this instructor'} on ${formatAttendanceDate(record?.date)}.`}
        detail="A record cannot exist without its check-in, so the check-out, both appearance reports and both photographs go with it. This cannot be undone."
        confirmLabel="Delete record"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(null)}
      />

      <ConfirmDialog
        open={confirmDelete === 'checkout'}
        destructive
        busy={deleting}
        title="Delete this check-out?"
        message={`This removes the check-out for ${record?.instructor_name || 'this instructor'} on ${formatAttendanceDate(record?.check_out_time || record?.date)}.`}
        detail="Its time, photograph and appearance report are deleted. The check-in and its report are untouched, and the instructor will be checked in again."
        confirmLabel="Delete check-out"
        onConfirm={handleDeleteCheckout}
        onCancel={() => setConfirmDelete(null)}
      />
    </section>
  );
}
