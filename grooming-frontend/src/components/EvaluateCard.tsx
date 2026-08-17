import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Camera, UploadCloud, RefreshCw, LogOut, MapPin, SwitchCamera } from 'lucide-react';
import { apiFetch } from '../api';
import { validatePhoto, validateSourcePhoto } from '../imageValidation';
import { preparePhoto } from '../lib/imageCapture';
import {
  describeAccuracy,
  formatCoordinates,
  getCachedFix,
  requestFix,
  type Fix,
} from '../lib/location';
import { useToast } from './useToast';
import type { Instructor } from '../types';

interface EvaluateCardProps {
  instructors: Instructor[];
  fetchInstructors: () => Promise<void> | void;
}

/** Poll cadence while an analysis is running. */
const STATUS_POLL_MS = 3000;
/** Stop polling after this long so a stuck job cannot poll forever. */
const STATUS_POLL_TIMEOUT_MS = 3 * 60_000;

interface AnalysisStatus {
  attendance_id: string;
  status: string;
  compliance_status: string | null;
  remarks: string | null;
  settled: boolean;
  requires_human_review: boolean;
}

export default function EvaluateCard({ instructors, fetchInstructors }: EvaluateCardProps) {
  const [selectedUuid, setSelectedUuid] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [locationStatus, setLocationStatus] = useState('');
  const [message, setMessage] = useState({ type: '', text: '' });
  const [fix, setFix] = useState<Fix | null>(() => getCachedFix());
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [preparing, setPreparing] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisStatus | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toast = useToast();

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  /**
   * Ask for location once when the screen opens, not on every check-in.
   * Repeated prompts are slow and train people to dismiss the dialog.
   */
  useEffect(() => {
    let disposed = false;
    if (getCachedFix()) return undefined;
    setLocationStatus('Getting your location…');
    requestFix().then((result) => {
      if (disposed) return;
      setFix(result);
      setLocationStatus(
        result ? '' : 'Location unavailable. Attendance will be recorded without coordinates.',
      );
    });
    return () => {
      disposed = true;
    };
  }, []);

  /**
   * Follow one analysis to completion so the result appears without a reload.
   * Polling stops as soon as the record settles, or after a cap so a stuck
   * job cannot poll indefinitely.
   */
  const trackAnalysis = useCallback((attendanceId: string) => {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (Date.now() - startedAt > STATUS_POLL_TIMEOUT_MS) {
        setAnalysis((current) => (current ? { ...current, status: 'timeout' } : current));
        return;
      }
      try {
        const status = await apiFetch<AnalysisStatus>(
          `/api/v2/attendance/${encodeURIComponent(attendanceId)}/status`,
        );
        setAnalysis(status);
        if (status.settled) {
          const compliant = status.compliance_status === 'COMPLIANT';
          if (status.requires_human_review) {
            toast.warning('Analysis needs a manual review', { detail: status.remarks || undefined });
          } else if (compliant) {
            toast.success('Grooming check passed', { detail: status.remarks || undefined });
          } else {
            toast.warning('Grooming issues found', { detail: status.remarks || undefined });
          }
          return;
        }
      } catch {
        // A dropped poll is not worth surfacing; the next one usually works.
      }
      timer = setTimeout(poll, STATUS_POLL_MS);
    };

    timer = setTimeout(poll, STATUS_POLL_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const resetPhoto = () => {
    setFile(null);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];

    // Check the camera file loosely, then downscale, then apply the real
    // limit. Validating the original first rejected ordinary phone photos:
    // a 12MP capture is around 11 MB and becomes ~400 KB once resized, so the
    // 8 MB rule was refusing images the system handles fine.
    const sourceError = validateSourcePhoto(selected);
    if (sourceError) {
      resetPhoto();
      setMessage({ type: 'error', text: sourceError });
      return;
    }

    setPreparing(true);
    setMessage({ type: '', text: '' });
    try {
      const prepared = await preparePhoto(selected as File);
      const validationError = validatePhoto(prepared.file);
      if (validationError) {
        resetPhoto();
        setMessage({ type: 'error', text: validationError });
        return;
      }
      setFile(prepared.file);
      setPreview(URL.createObjectURL(prepared.file));
    } catch {
      resetPhoto();
      setMessage({ type: 'error', text: 'That photo could not be read. Try taking it again.' });
    } finally {
      setPreparing(false);
    }
  };

  const handleCheckIn = async () => {
    const photoError = validatePhoto(file);
    if (!selectedUuid || photoError) {
      setMessage({
        type: 'error',
        text: !selectedUuid ? 'Select an instructor to continue.' : photoError,
      });
      return;
    }

    setLoading(true);
    setMessage({ type: '', text: '' });
    setAnalysis(null);

    // Use the fix captured when the screen opened rather than waiting on the
    // GPS now, so submitting never stalls behind a location lookup.
    const currentFix = fix ?? getCachedFix();
    const coordinates = formatCoordinates(currentFix);

    const formData = new FormData();
    formData.append('instructor_id', selectedUuid);
    // Already downscaled when it was selected, so upload as-is.
    formData.append('file', file as File);
    if (coordinates) {
      formData.append('location_coordinates', coordinates);
      formData.append('location_accuracy_m', String(currentFix?.accuracyMetres ?? ''));
    }

    try {
      const result = await apiFetch<{ message?: string; attendance_id?: string }>(
        '/api/v2/attendance/check-in',
        { method: 'POST', body: formData, timeoutMs: 75_000 },
      );
      setMessage({ type: 'success', text: result?.message || 'Check-in recorded. Analysis is running.' });
      toast.success('Check-in recorded', { detail: 'Grooming analysis is running in the background.' });
      resetPhoto();
      setSelectedUuid('');
      if (result?.attendance_id) {
        setAnalysis({
          attendance_id: result.attendance_id,
          status: 'pending',
          compliance_status: null,
          remarks: null,
          settled: false,
          requires_human_review: false,
        });
        trackAnalysis(result.attendance_id);
      }
      void fetchInstructors();
      // Refresh the fix quietly for the next check-in without blocking this one.
      void requestFix({ force: true }).then(setFix);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage({ type: 'error', text: `Check-in failed: ${text}` });
      toast.error('Check-in failed', { detail: text });
    } finally {
      setLoading(false);
    }
  };

  const handleCheckOut = async () => {
    if (!selectedUuid) {
      setMessage({ type: 'error', text: 'Select an instructor to check out.' });
      return;
    }

    setCheckoutLoading(true);
    setMessage({ type: '', text: '' });
    try {
      // Multipart so an optional check-out photo rides along. Check-out still
      // succeeds without one.
      const formData = new FormData();
      formData.append('instructor_id', selectedUuid);
      // Downscaled at selection time, so no further processing is needed.
      if (file) formData.append('file', file);
      const currentFix = fix ?? getCachedFix();
      const coordinates = formatCoordinates(currentFix);
      if (coordinates) formData.append('location_coordinates', coordinates);

      const result = await apiFetch<{ message?: string }>('/api/v2/attendance/check-out', {
        method: 'POST',
        body: formData,
      });
      setMessage({ type: 'success', text: result?.message || 'Check-out completed.' });
      toast.success('Check-out recorded');
      resetPhoto();
      setSelectedUuid('');
      void fetchInstructors();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage({ type: 'error', text: `Check-out failed: ${text}` });
      toast.error('Check-out failed', { detail: text });
    } finally {
      setCheckoutLoading(false);
    }
  };

  return (
    <section className="bg-white rounded-md shadow-xl shadow-slate-200/50 p-6 md:p-8 flex flex-col h-full border border-slate-100 relative overflow-hidden group" aria-labelledby="attendance-action-title">
      <div className="absolute top-0 right-0 -mt-16 -mr-16 w-48 h-48 bg-indigo-50 rounded-full blur-3xl opacity-60 pointer-events-none group-hover:bg-indigo-100 transition-colors duration-700" />

      <div className="relative z-10">
        <h2 id="attendance-action-title" className="text-xl md:text-2xl font-extrabold text-slate-800 mb-2 tracking-tight">Attendance Action</h2>
        <p className="text-slate-500 text-sm mb-6 font-medium">Select an instructor to check in or check out.</p>

        {message.text && (
          <div
            role={message.type === 'error' ? 'alert' : 'status'}
            className={`mb-5 rounded-md border p-3 text-sm font-medium ${message.type === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}
          >
            {message.text}
          </div>
        )}

        <div className="mb-6">
          <label htmlFor="instructor-select" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Select Instructor</label>
          <div className="relative">
            <select
              id="instructor-select"
              className="w-full rounded-md border-2 border-slate-100 bg-slate-50 p-4 text-sm font-medium text-slate-700 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none appearance-none cursor-pointer transition-all hover:bg-slate-100"
              value={selectedUuid}
              onChange={(event) => setSelectedUuid(event.target.value)}
            >
              <option value="">-- Choose Instructor --</option>
              {instructors.map((instructor: Instructor) => (
                <option key={instructor._id} value={instructor._id}>{instructor.name} ({instructor.employee_id})</option>
              ))}
            </select>
            <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none text-slate-400" aria-hidden="true">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col mb-6">
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="check-in-photo" className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Check-In Photo</label>
            {/* Grooming shots are usually selfies, so the front camera is the
                default, but the rear camera stays one tap away. */}
            <button
              type="button"
              onClick={() => setFacing((current) => (current === 'user' ? 'environment' : 'user'))}
              className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              <SwitchCamera size={14} aria-hidden="true" />
              {facing === 'user' ? 'Front camera' : 'Back camera'}
            </button>
          </div>
          <div className="flex-1 min-h-[240px] border-3 border-dashed border-slate-200 rounded-md flex flex-col items-center justify-center bg-slate-50/50 relative overflow-hidden transition-all hover:border-indigo-400 hover:bg-indigo-50/30 group/drop">
            <input
              // Remounting on facing change is required: browsers read the
              // capture attribute when the picker opens, so mutating it on a
              // live input has no effect on which camera launches.
              key={facing}
              ref={fileInputRef}
              id="check-in-photo"
              type="file"
              // HEIC is accepted because iPhones produce it by default; it is
              // re-encoded to JPEG during downscaling before it ever uploads.
              accept=".jpg,.jpeg,.png,.webp,.heic,.heif,image/jpeg,image/png,image/webp,image/heic,image/heif"
              capture={facing}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              onChange={handleFileChange}
            />
            {preparing ? (
              <div className="flex flex-col items-center text-slate-500 p-6 text-center" role="status">
                <RefreshCw size={28} className="animate-spin mb-3" aria-hidden="true" />
                <p className="font-bold text-sm">Preparing photo…</p>
              </div>
            ) : preview ? (
              <img src={preview} alt="Selected check-in preview" className="absolute inset-0 w-full h-full object-cover object-top" />
            ) : (
              <div className="flex flex-col items-center text-slate-400 group-hover/drop:text-indigo-500 transition-colors p-6 text-center">
                <div className="w-16 h-16 rounded-md bg-white shadow-sm flex items-center justify-center mb-4 group-hover/drop:scale-110 transition-transform duration-300">
                  <Camera size={32} aria-hidden="true" />
                </div>
                <p className="font-bold text-sm text-slate-600 mb-1">Take or upload a photo</p>
                <p className="text-xs font-medium px-4 leading-relaxed">JPEG, PNG, HEIC, or WebP.</p>
              </div>
            )}
          </div>
        </div>

        {/* Show the accuracy, not just that a location exists: a 3km IP-based
            reading and a 5m GPS fix look identical without it. */}
        {fix && !locationStatus && (
          <p className="text-xs text-slate-500 font-medium mb-3 flex items-center gap-1">
            <MapPin size={12} aria-hidden="true" />
            Location ready {describeAccuracy(fix) ? `(${describeAccuracy(fix)})` : ''}
          </p>
        )}

        {locationStatus && (
          <p role="status" className="text-xs text-indigo-600 font-bold mb-3 flex items-center gap-1">
            <MapPin size={12} aria-hidden="true" /> {locationStatus}
          </p>
        )}

        {analysis && (
          <div
            role="status"
            aria-live="polite"
            className={`mb-4 rounded-md border p-3 text-sm ${
              analysis.settled
                ? analysis.compliance_status === 'COMPLIANT'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-indigo-200 bg-indigo-50 text-indigo-800'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold">
              {!analysis.settled && <RefreshCw size={14} className="animate-spin" aria-hidden="true" />}
              {analysis.status === 'timeout'
                ? 'Analysis is taking longer than usual'
                : analysis.settled
                  ? analysis.requires_human_review
                    ? 'Needs manual review'
                    : analysis.compliance_status === 'COMPLIANT'
                      ? 'Grooming check passed'
                      : 'Grooming issues found'
                  : 'Analysing photo…'}
            </div>
            {analysis.remarks && <p className="mt-1 text-xs opacity-90">{analysis.remarks}</p>}
            {analysis.status === 'timeout' && (
              <p className="mt-1 text-xs opacity-90">
                It will finish in the background. Check Daily Records shortly.
              </p>
            )}
          </div>
        )}

        <div className="flex gap-4">
          <button
            type="button"
            onClick={handleCheckIn}
            disabled={loading || checkoutLoading}
            className={`flex-1 rounded-md py-4 font-bold text-sm flex items-center justify-center gap-2 transition-all ${loading ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-[#8b5cf6] text-white hover:bg-[#7c3aed] shadow-lg shadow-indigo-200 hover:-translate-y-0.5'}`}
          >
            {loading ? <RefreshCw size={18} className="animate-spin" aria-hidden="true" /> : <UploadCloud size={18} aria-hidden="true" />}
            {loading ? 'Submitting…' : 'Check-In'}
          </button>

          <button
            type="button"
            onClick={handleCheckOut}
            disabled={loading || checkoutLoading}
            className={`flex-1 rounded-md py-4 font-bold text-sm flex items-center justify-center gap-2 transition-all ${checkoutLoading ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-rose-50 text-rose-600 hover:bg-rose-100 border border-rose-200'}`}
          >
            {checkoutLoading ? <RefreshCw size={18} className="animate-spin" aria-hidden="true" /> : <LogOut size={18} aria-hidden="true" />}
            {checkoutLoading ? 'Submitting…' : 'Check-Out'}
          </button>
        </div>
      </div>
    </section>
  );
}
