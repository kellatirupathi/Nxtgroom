import { useEffect, useState } from 'react';
import { ArrowLeft, User, Clock, Calendar, CheckCircle2, XCircle, TriangleAlert, CircleAlert } from 'lucide-react';
import { apiFetch } from '../api';
import { imageQualityLabel, needsHumanReview, normalizeAttendanceStatus } from '../status';
import GroomingReport from './GroomingReport';
import LocationPanel from './LocationPanel';
import type { AttendanceRecord, Evaluation } from '../types';

interface InstructorDetailProps {
  record: AttendanceRecord | null;
  onBack: () => void;
}

function StatusBadge({ status }: { status?: string }) {
  switch (normalizeAttendanceStatus(status)) {
    case 'compliant':
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-emerald-50 text-emerald-600 border border-emerald-200"><CheckCircle2 size={16} aria-hidden="true" /> Compliant</span>;
    case 'non_compliant':
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-rose-50 text-rose-600 border border-rose-200"><XCircle size={16} aria-hidden="true" /> Non-compliant</span>;
    case 'review_required':
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-amber-50 text-amber-700 border border-amber-200"><CircleAlert size={16} aria-hidden="true" /> Review required</span>;
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

export default function InstructorDetail({ record, onBack }: InstructorDetailProps) {
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [loading, setLoading] = useState(Boolean(record));
  const [error, setError] = useState('');

  useEffect(() => {
    if (!record) return undefined;
    const controller = new AbortController();
    const fetchEvaluation = async () => {
      setLoading(true);
      setEvaluation(null);
      setError('');
      try {
        const data = await apiFetch<Evaluation>(`/api/v2/attendance/${encodeURIComponent(record._id)}/evaluation`, { signal: controller.signal });
        setEvaluation(data);
      } catch (requestError) {
        if (!controller.signal.aborted && (requestError as { status?: number })?.status !== 401) setError(requestError instanceof Error ? requestError.message : String(requestError));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    fetchEvaluation();
    return () => controller.abort();
  }, [record]);

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
      <div className="flex items-center gap-4 mb-6 shrink-0">
        <button type="button" aria-label="Back to daily records" onClick={onBack} className="p-2 bg-white border border-slate-200 rounded-md hover:bg-slate-50 text-slate-600 transition-colors shadow-sm">
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h2 id="instructor-detail-title" className="text-2xl font-extrabold text-slate-800">Instructor Detail View</h2>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 flex-1 min-h-0 overflow-hidden">
        <div className="w-full lg:w-1/3 flex flex-col gap-6 overflow-y-auto pb-6 pr-2">
          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-8 flex flex-col items-center text-center shrink-0">
            <div className="w-24 h-24 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center mb-5"><User size={48} aria-hidden="true" /></div>
            <h3 className="text-2xl font-extrabold text-slate-800">{record.instructor_name}</h3>
            <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mt-1.5 mb-5">{record.instructor_role}</p>
            <StatusBadge status={record.status} />
          </div>

          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-6 space-y-5 shrink-0">
            <h4 className="text-sm font-bold text-slate-800 border-b border-slate-100 pb-3">Session Details</h4>
            <div className="flex items-start gap-4"><div className="bg-slate-50 p-2 rounded-md text-slate-400"><Calendar size={18} aria-hidden="true" /></div><div><p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Date</p><p className="text-sm font-semibold text-slate-700">{formatDate(record.date)}</p></div></div>
            <div className="flex items-start gap-4"><div className="bg-slate-50 p-2 rounded-md text-slate-400"><Clock size={18} aria-hidden="true" /></div><div><p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Check-In Time</p><p className="text-sm font-semibold text-slate-700">{formatTime(record.check_in_time)}</p></div></div>
            <div className="flex items-start gap-4"><div className="bg-slate-50 p-2 rounded-md text-slate-400"><Clock size={18} aria-hidden="true" /></div><div><p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Check-Out Time</p><p className="text-sm font-semibold text-slate-700">{formatTime(record.check_out_time)}</p></div></div>
            <div>
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Location</p>
              <LocationPanel
                coordinates={record.location_coordinates}
                address={record.location_address}
                accuracyMetres={record.location_accuracy_m}
              />
            </div>
          </div>

          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-6 shrink-0">
            <h4 className="text-sm font-bold text-slate-800 border-b border-slate-100 pb-3 mb-4">AI Remarks Summary</h4>
            <p className="text-sm text-slate-600 leading-relaxed bg-slate-50 p-4 rounded-md border border-slate-100">{record.remarks || 'No remarks available.'}</p>
            <p className="mt-3 text-xs text-slate-400">AI output is assistive and should be reviewed by an authorized person before adverse action.</p>
          </div>
        </div>

        <div className="w-full lg:w-2/3 bg-white rounded-md shadow-sm border border-slate-200 p-8 overflow-y-auto flex flex-col mb-6">
          <h3 className="text-lg font-extrabold text-slate-800 mb-6 border-b border-slate-100 pb-4">Detailed Appearance Report</h3>
          {loading ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-4" role="status"><div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" /><p className="text-sm font-medium">Fetching detailed evaluation…</p></div>
          ) : error ? (
            <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">{error}</div>
          ) : !evaluation ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-500 font-medium bg-slate-50 rounded-md border border-dashed border-slate-200 p-8 text-center gap-2"><XCircle size={32} className="text-slate-300" aria-hidden="true" /><p>No detailed evaluation report is available.</p></div>
          ) : (
            <div className="flex-1 pb-4">
              {needsHumanReview(record.status, evaluation) && (
                <div role="note" className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-amber-900">
                  <div className="flex items-start gap-3">
                    <CircleAlert size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <div>
                      <h4 className="text-sm font-extrabold">Human review required</h4>
                      <p className="mt-1 text-sm leading-relaxed">
                        {evaluation.image_quality === 'RETAKE_RECOMMENDED'
                          ? 'The image did not support a reliable assessment of every critical checkpoint. Retake the photo and have an authorized reviewer confirm the result.'
                          : normalizeAttendanceStatus(record.status) === 'review_required'
                            ? 'At least one critical checkpoint needs confirmation by an authorized reviewer before this result is treated as compliant.'
                            : 'An authorized reviewer must confirm the AI findings before any action is taken.'}
                      </p>
                      <p className="mt-2 text-xs font-bold uppercase tracking-wide">
                        Image quality: {imageQualityLabel(evaluation.image_quality)}
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
    </section>
  );
}
