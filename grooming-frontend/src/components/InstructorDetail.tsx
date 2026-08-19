import { useEffect, useState } from 'react';
import { ArrowLeft, Clock, Calendar, CheckCircle2, XCircle, TriangleAlert, CircleAlert, LogIn, LogOut, Trash2 } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import ConfirmDialog from './ConfirmDialog';
import PhotoViewer from './PhotoViewer';
import AttendancePhotoCircle from './AttendancePhotoCircle';
import { useToast } from './useToast';
import { normalizeAttendanceStatus } from '../status';
import GroomingReport from './GroomingReport';
import LocationPanel from './LocationPanel';
import type { AttendanceRecord, Evaluation } from '../types';

interface InstructorDetailProps {
  record: AttendanceRecord | null;
  onBack: () => void;
  /** Hidden entirely when the signed-in user may not delete. */
  canDelete?: boolean;
  /** Called after the record is gone, so the list behind can drop it. */
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

function formatTime(isoString?: string | null) {
  if (!isoString) return '--';
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(isoString?: string | null) {
  if (!isoString) return '--';
  return new Date(isoString).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function InstructorDetail({ record, onBack, canDelete, onDeleted }: InstructorDetailProps) {
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [loading, setLoading] = useState(Boolean(record));
  const [error, setError] = useState('');
  const [photoKind, setPhotoKind] = useState<'checkin' | 'checkout' | null>(null);
  // Check-in opens first: it is the half that carries the appearance report,
  // and on most records the only half that has happened yet.
  const [tab, setTab] = useState<'checkin' | 'checkout'>('checkin');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();

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
      setConfirmDelete(false);
      // Back to the list, which no longer contains this record: staying here
      // would leave the page describing something that no longer exists.
      onDeleted?.(String(record._id));
      onBack();
    } catch (deleteError) {
      toast.error('Could not delete the record', {
        detail: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
      setDeleting(false);
    }
  };

  useEffect(() => {
    if (!record) return undefined;
    const controller = new AbortController();
    const fetchEvaluation = async () => {
      setLoading(true);
      setEvaluation(null);
      setError('');
      try {
        // Each half is assessed separately, so the tab decides which report
        // is fetched rather than both halves sharing one.
        const query = tab === 'checkout' ? '?kind=checkout' : '';
        const data = await apiFetch<Evaluation>(`/api/v2/attendance/${encodeURIComponent(record._id)}/evaluation${query}`, { signal: controller.signal });
        setEvaluation(data);
      } catch (requestError) {
        if (!controller.signal.aborted && (requestError as { status?: number })?.status !== 401) setError(requestError instanceof Error ? requestError.message : String(requestError));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    fetchEvaluation();
    return () => controller.abort();
  }, [record, tab]);

  if (!record) {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-8 text-center">
        <p className="text-sm text-slate-500">Choose a completed attendance record to view its report.</p>
        <button type="button" onClick={onBack} className="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-sm font-bold text-white">Back to records</button>
      </div>
    );
  }

  return (
    <section className="w-full flex flex-col h-full animate-in fade-in slide-in-from-right-4 duration-300" aria-labelledby="instructor-detail-title">
      <div className="flex flex-wrap items-center gap-3 sm:gap-4 mb-6 shrink-0">
        <button type="button" aria-label="Back to daily records" onClick={onBack} className="p-2 bg-white border border-slate-200 rounded-md hover:bg-slate-50 text-slate-600 transition-colors shadow-sm">
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h2 id="instructor-detail-title" className="text-xl sm:text-2xl font-extrabold text-slate-800">Instructor Detail View</h2>

        {/* Acts on the record as a whole, so it sits with the title rather
            than inside the profile card, which describes the person. */}
        {canDelete && (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            aria-label="Delete this attendance record"
            title="Delete this attendance record"
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700 transition-colors hover:bg-rose-100"
          >
            <Trash2 size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Delete</span>
          </button>
        )}
      </div>

      {/* One record, two halves. Switching swaps the photo, the time and the
          location together, so what is on screen always describes the same
          moment rather than mixing the two. */}
      <div role="tablist" aria-label="Attendance report" className="mb-4 flex shrink-0 gap-1 rounded-md border border-slate-200 bg-white p-1 sm:w-fit">
        {([
          { key: 'checkin', label: 'Check-in report', Icon: LogIn },
          { key: 'checkout', label: 'Check-out report', Icon: LogOut },
        ] as const).map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs sm:text-sm font-bold transition-colors sm:flex-none ${
              tab === key
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Icon size={15} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {/* Nothing about a check-out that has not happened is worth laying out.
          Splitting it across a status badge from the other half, an empty
          time, an empty location and an empty summary made the page look
          broken rather than pending, so it says the one true thing instead. */}
      {tab === 'checkout' && !record.check_out_time ? (
        <div className="flex flex-1 min-h-0 items-start justify-center overflow-y-auto lg:items-center">
          <div className="w-full max-w-lg rounded-md border border-dashed border-slate-300 bg-white p-6 sm:p-10 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-500">
              <LogOut size={26} aria-hidden="true" />
            </div>
            <h3 className="text-base sm:text-lg font-extrabold text-slate-800">No check-out recorded</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-500">
              {record.instructor_name || 'This instructor'} checked in at {formatTime(record.check_in_time)} on{' '}
              {formatDate(record.date)} and has not checked out. Please follow up with them.
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
      <div className="flex flex-col lg:flex-row gap-6 flex-1 min-h-0 lg:overflow-hidden">
        {/* pr-2 only once the column can scroll on its own; below lg the page
            scrolls as one and an inner scrollbar would trap the content. */}
        <div className="w-full lg:w-1/3 flex flex-col gap-4 sm:gap-6 lg:overflow-y-auto lg:pb-6 lg:pr-2">
          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-5 sm:p-8 flex flex-col items-center text-center shrink-0">
            <AttendancePhotoCircle
              attendanceId={String(record._id)}
              kind={tab}
              hasPhoto={Boolean(tab === 'checkin' ? record.check_in_photo_key : record.check_out_photo_key)}
              label={tab === 'checkin' ? 'Check-in' : 'Check-out'}
              onOpen={() => setPhotoKind(tab)}
            />
            <h3 className="mt-4 text-xl sm:text-2xl font-extrabold text-slate-800">{record.instructor_name}</h3>
            <p className="text-xs sm:text-sm font-bold text-slate-400 uppercase tracking-widest mt-1.5 mb-4 sm:mb-5">{record.instructor_role}</p>
            <StatusBadge status={record.status} />
            {tab === 'checkout' && !record.check_out_photo_key && (
              <p className="mt-4 text-xs font-medium text-slate-400">No photo was taken at check-out.</p>
            )}
          </div>

          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-5 sm:p-6 space-y-5 shrink-0">
            <h4 className="text-sm font-bold text-slate-800 border-b border-slate-100 pb-3">Session Details</h4>
            <div className="flex items-start gap-4"><div className="bg-slate-50 p-2 rounded-md text-slate-400"><Calendar size={18} aria-hidden="true" /></div><div><p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Date</p><p className="text-sm font-semibold text-slate-700">{formatDate(record.date)}</p></div></div>
            {/* Only this tab's half. Showing the other one's time here put an
                empty check-out row on a report about the check-in. */}
            <div className="flex items-start gap-4">
              <div className="bg-indigo-50 text-indigo-600 p-2 rounded-md"><Clock size={18} aria-hidden="true" /></div>
              <div>
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">
                  {tab === 'checkin' ? 'Check-in time' : 'Check-out time'}
                </p>
                <p className="text-sm font-semibold text-slate-800">
                  {formatTime(tab === 'checkin' ? record.check_in_time : record.check_out_time)}
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
                  address={tab === 'checkin' ? record.location_address : null}
                  accuracyMetres={tab === 'checkin' ? record.location_accuracy_m : null}
                />
              )}
            </div>
          </div>

          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-5 sm:p-6 shrink-0">
            <h4 className="text-sm font-bold text-slate-800 border-b border-slate-100 pb-3 mb-4">AI Remarks Summary</h4>
            <p className="text-sm text-slate-600 leading-relaxed bg-slate-50 p-4 rounded-md border border-slate-100">{record.remarks || 'No remarks available.'}</p>
            <p className="mt-3 text-xs text-slate-400">AI output is assistive and should be reviewed by an authorized person before adverse action.</p>
          </div>
        </div>

        <div className="w-full lg:w-2/3 bg-white rounded-md shadow-sm border border-slate-200 p-5 sm:p-8 lg:overflow-y-auto flex flex-col mb-4 lg:mb-6">
          <h3 className="text-base sm:text-lg font-extrabold text-slate-800 mb-4 sm:mb-6 border-b border-slate-100 pb-3 sm:pb-4">
            Detailed Appearance Report
          </h3>
          {/* Both halves are assessed the same way, so both render the same
              report. The check-out one only exists when a photo was taken. */}
          {loading ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-4" role="status"><div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" /><p className="text-sm font-medium">Fetching detailed evaluation…</p></div>
          ) : error ? (
            <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">{error}</div>
          ) : !evaluation ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-500 font-medium bg-slate-50 rounded-md border border-dashed border-slate-200 p-8 text-center gap-2">
              <XCircle size={32} className="text-slate-300" aria-hidden="true" />
              <p>
                {tab === 'checkout' && !record.check_out_photo_key
                  ? 'No photo was taken at check-out, so there is nothing to assess.'
                  : 'No detailed evaluation report is available.'}
              </p>
            </div>
          ) : (
            <div className="flex-1 pb-4">
              {/* The verdict stands whatever the photo was like. This only
                  asks for a better one next time, so the checkpoints that
                  could not be seen can be. */}
              {evaluation.image_quality === 'RETAKE_RECOMMENDED' && (
                <div role="note" className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-amber-900">
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
              <GroomingReport evaluation={evaluation} />
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
          subtitle={`${photoKind === 'checkin' ? 'Check-in' : 'Check-out'} · ${formatDate(record.date)}`}
          onClose={() => setPhotoKind(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        destructive
        busy={deleting}
        title="Delete this attendance record?"
        message={`This removes the check-in for ${record?.instructor_name || 'this instructor'} on ${formatDate(record?.date)}.`}
        detail="The appearance report and both photographs are deleted with it. This cannot be undone."
        confirmLabel="Delete record"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}
