import { useEffect, useState } from 'react';
import { Calendar, Camera, FileText, UploadCloud, RefreshCw, LogOut, MapPin, SwitchCamera } from 'lucide-react';
import { ApiError, apiFetch } from '../api';
import { validatePhoto, validateSourcePhoto } from '../imageValidation';
import { preparePhoto } from '../lib/imageCapture';
import {
  describeAccuracy,
  formatCoordinates,
  getCachedFix,
  pauseLocationWatch,
  resumeLocationWatch,
  subscribeToLocation,
  type Fix,
  type LocationStatus,
} from '../lib/location';
import AuditReportModal from './AuditReportModal';
import CameraCapture from './CameraCapture';
import { preloadFullBodyDetector } from '../lib/fullBodyDetector';
import { armBeepUnlock, playSuccessBeep } from '../lib/successBeep';
import { BODY_REGIONS_FIELD, type BodyRegions, type CaptureDetails } from '../lib/bodyRegions';
import InstructorSearchSelect from './InstructorSearchSelect';
import { useToast } from './useToast';
import { pathForTab } from '../routes';
import { TABS } from '../routes';
import type { Instructor } from '../types';
import { formatAttendanceDate } from '../attendanceFilters';
import MissingGenderModal from './MissingGenderModal';

interface EvaluateCardProps {
  instructors: Instructor[];
  fetchInstructors: () => Promise<void> | void;
  onInstructorGenderSaved: (instructorId: string, gender: string) => void;
  faceIdentification?: boolean;
}

export default function EvaluateCard({
  instructors,
  fetchInstructors,
  onInstructorGenderSaved,
  faceIdentification = false,
}: EvaluateCardProps) {
  const [selectedUuid, setSelectedUuid] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [bodyRegions, setBodyRegions] = useState<BodyRegions | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [locationStatus, setLocationStatus] = useState('');
  const [message, setMessage] = useState({ type: '', text: '' });
  const [fix, setFix] = useState<Fix | null>(() => getCachedFix());
  const [locationState, setLocationState] = useState<LocationStatus>('idle');
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [preparing, setPreparing] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [missingGenderInstructor, setMissingGenderInstructor] = useState<Instructor | null>(null);
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<
    {
      attendanceId: string | null;
      instructorName: string;
      saveError?: string;
      retryFile?: File;
      kind: 'checkin' | 'checkout';
    } | null
  >(null);
  const toast = useToast();

  useEffect(() => {
    preloadFullBodyDetector();
  }, []);

  useEffect(() => armBeepUnlock(), []);

  const selectInstructor = (instructorId: string) => {
    setSelectedUuid(instructorId);
    const instructor = instructors.find((item) => item._id === instructorId);
    if (instructor && !['MALE', 'FEMALE'].includes(String(instructor.gender || '').toUpperCase())) {
      setMissingGenderInstructor(instructor);
    } else {
      setMissingGenderInstructor(null);
    }
  };

  const requireSelectedGender = (): boolean => {
    const instructor = instructors.find((item) => item._id === selectedUuid);
    if (!instructor || ['MALE', 'FEMALE'].includes(String(instructor.gender || '').toUpperCase())) {
      return true;
    }
    setMissingGenderInstructor(instructor);
    return false;
  };

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  useEffect(() => {
    const unsubscribe = subscribeToLocation((next, status) => {
      setFix(next);
      setLocationState(status);
      setLocationStatus(
        status === 'denied'
          ? 'Location permission is blocked. Enable it in your browser settings to record where check-ins happen.'
          : status === 'unavailable'
            ? 'Location unavailable. Attendance will be recorded without coordinates.'
            : '',
      );
    });

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') pauseLocationWatch();
      else resumeLocationWatch();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
    };
  }, []);

  const resetPhoto = () => {
    setFile(null);
    setPreview(null);
    setBodyRegions(null);
  };

  const handleCapture = async (selected: File, details?: CaptureDetails) => {
    setCameraOpen(false);

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
      setBodyRegions(details?.bodyRegions ?? null);
    } catch {
      resetPhoto();
      setMessage({ type: 'error', text: 'That photo could not be read. Try taking it again.' });
    } finally {
      setPreparing(false);
    }
  };

  const handleCheckIn = async () => {
    const photoError = validatePhoto(file);
    if (photoError || (!faceIdentification && !selectedUuid)) {
      setMessage({
        type: 'error',
        text: photoError || 'Select an instructor to continue.',
      });
      return;
    }
    if (!faceIdentification && !requireSelectedGender()) return;

    setLoading(true);
    setMessage({ type: '', text: '' });
    setActiveRecordId(null);

    const submittedName = faceIdentification
      ? 'Identifying…'
      : instructors.find((item) => item._id === selectedUuid)?.name || 'Instructor';
    setReportTarget({ attendanceId: null, instructorName: submittedName, kind: 'checkin' });

    const currentFix = fix ?? getCachedFix();
    const coordinates = formatCoordinates(currentFix);

    const formData = new FormData();
    if (!faceIdentification) formData.append('instructor_id', selectedUuid);
    formData.append('file', file as File);
    if (bodyRegions) formData.append(BODY_REGIONS_FIELD, JSON.stringify(bodyRegions));
    if (coordinates) {
      formData.append('location_coordinates', coordinates);
      formData.append('location_accuracy_m', String(currentFix?.accuracyMetres ?? ''));
    }

    try {
      let result: { message?: string; attendance_id?: string };
      try {
        result = await apiFetch('/api/v2/attendance/check-in', {
          method: 'POST', body: formData, timeoutMs: 75_000,
        });
      } catch (requestError) {
        if (!(requestError instanceof ApiError) || requestError.status !== 503) throw requestError;
        await new Promise((resolve) => window.setTimeout(resolve, 5_000));
        result = await apiFetch('/api/v2/attendance/check-in', {
          method: 'POST', body: formData, timeoutMs: 75_000,
        });
      }
      resetPhoto();
      setSelectedUuid('');
      playSuccessBeep();
      if (result?.attendance_id) {
        setReportTarget((current) => (
          current ? { ...current, attendanceId: result.attendance_id as string } : current
        ));
      } else {
        setReportTarget(null);
      }
      void fetchInstructors();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (error instanceof ApiError && error.status === 409) {
        const existingId = (error.details as { attendance_id?: string } | null)?.attendance_id;
        setReportTarget(null);
        setActiveRecordId(existingId ?? null);
        setMessage({ type: 'error', text });
        toast.error('Already checked in', { detail: text });
        return;
      }
      setReportTarget((current) => (current ? { ...current, saveError: text } : current));
      toast.error('Check-in failed', { detail: text });
    } finally {
      setLoading(false);
    }
  };

  const handleCheckOut = async () => {
    if (faceIdentification) {
      if (!file) {
        setMessage({ type: 'error', text: 'Take a photo to check out.' });
        return;
      }
    } else {
      if (!selectedUuid) {
        setMessage({ type: 'error', text: 'Select an instructor to check out.' });
        return;
      }
      if (!requireSelectedGender()) return;
    }

    setCheckoutLoading(true);
    setMessage({ type: '', text: '' });
    setActiveRecordId(null);

    const submittedName = faceIdentification
      ? 'Identifying…'
      : instructors.find((item) => item._id === selectedUuid)?.name || 'Instructor';
    const hasPhoto = Boolean(file);
    if (hasPhoto) {
      setReportTarget({ attendanceId: null, instructorName: submittedName, kind: 'checkout' });
    }

    try {
      const formData = new FormData();
      if (!faceIdentification) formData.append('instructor_id', selectedUuid);
      if (file) formData.append('file', file);
      if (file && bodyRegions) formData.append(BODY_REGIONS_FIELD, JSON.stringify(bodyRegions));
      const currentFix = fix ?? getCachedFix();
      const coordinates = formatCoordinates(currentFix);
      if (coordinates) {
        formData.append('location_coordinates', coordinates);
        formData.append('location_accuracy_m', String(currentFix?.accuracyMetres ?? ''));
      }

      const result = await apiFetch<{
        message?: string;
        attendance_id?: string;
        analysis_completed?: boolean;
        analysis_failed?: boolean;
        photo_status?: 'stored' | 'failed' | 'not_provided';
        photo_warning?: string | null;
      }>(
        '/api/v2/attendance/check-out',
        { method: 'POST', body: formData, timeoutMs: 150_000 },
      );
      playSuccessBeep();
      if (hasPhoto && result?.attendance_id) {
        setReportTarget((current) => (
          current ? {
            ...current,
            attendanceId: result.attendance_id as string,
            ...(result.photo_status === 'failed'
              ? {
                saveError: result.photo_warning || 'The photo could not be stored.',
                retryFile: file || undefined,
              }
              : {}),
          } : current
        ));
      } else {
        setReportTarget(null);
      }
      if (result.photo_status !== 'failed') {
        resetPhoto();
        setSelectedUuid('');
      }
      void fetchInstructors();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (error instanceof ApiError && error.status === 409) {
        const details = error.details as { attendance_id?: string; outcome?: string } | null;
        const existingId = details?.attendance_id;
        setReportTarget(null);
        setActiveRecordId(existingId ?? null);
        setMessage({ type: 'error', text });
        toast.error(
          details?.outcome === 'TOO_EARLY' ? 'Check-out not open yet' : 'Already checked out',
          { detail: text },
        );
        return;
      }
      if (hasPhoto) {
        setReportTarget((current) => (current ? { ...current, saveError: text } : current));
      }
      setMessage({ type: 'error', text: `Check-out failed: ${text}` });
      toast.error('Check-out failed', { detail: text });
    } finally {
      setCheckoutLoading(false);
    }
  };

  const retryCheckoutPhoto = async () => {
    const target = reportTarget;
    if (!target?.attendanceId || !target.retryFile) return;
    const body = new FormData();
    body.append('file', target.retryFile);
    await apiFetch(
      `/api/v2/attendance/${encodeURIComponent(target.attendanceId)}/checkout-photo`,
      { method: 'POST', body, timeoutMs: 150_000 },
    );
    setReportTarget((current) => (current ? {
      ...current,
      saveError: undefined,
      retryFile: undefined,
    } : current));
    resetPhoto();
    setSelectedUuid('');
    void fetchInstructors();
  };

  return (
    <section className="bg-white rounded-md shadow-xl shadow-slate-200/50 p-6 md:p-8 flex flex-col h-full border border-slate-100 relative overflow-hidden group" aria-labelledby="attendance-action-title">
      <div className="absolute top-0 right-0 -mt-16 -mr-16 w-48 h-48 bg-indigo-50 rounded-full blur-3xl opacity-60 pointer-events-none group-hover:bg-indigo-100 transition-colors duration-700" />

      <div className="relative z-10">
        <div className="mb-2 flex items-center justify-between gap-4">
          <h2 id="attendance-action-title" className="text-xl md:text-2xl font-extrabold text-slate-800 tracking-tight">Attendance Action</h2>
          <p className="flex shrink-0 items-center gap-1.5 text-xs font-bold text-slate-500 sm:text-sm">
            <Calendar size={16} className="text-indigo-600" aria-hidden="true" />
            <span className="hidden sm:inline">Today,</span> {formatAttendanceDate(new Date())}
          </p>
        </div>
        <p className="text-slate-500 text-sm mb-6 font-medium">
          {faceIdentification
            ? 'Take a photo to check in or check out. The instructor is identified from it.'
            : 'Select an instructor to check in or check out.'}
        </p>

        {message.text && message.type === 'error' && (
          <div role="alert" className="mb-5 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
            <p>{message.text}</p>
            {activeRecordId && (
              <a
                href={pathForTab(TABS.INSTRUCTOR_DETAIL, activeRecordId)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 transition-colors"
              >
                <FileText size={13} aria-hidden="true" />
                View their report
              </a>
            )}
          </div>
        )}

        {!faceIdentification && (
          <div className="mb-6">
            <p className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Search Instructor</p>
            <InstructorSearchSelect
              instructors={instructors}
              selectedId={selectedUuid}
              onSelect={selectInstructor}
              disabled={loading || checkoutLoading}
            />
          </div>
        )}

        <div className="flex-1 flex flex-col mb-6">
          <div className="flex items-center justify-between mb-2">
            <p className="block text-xs font-bold text-slate-500 uppercase tracking-wider">
              {faceIdentification ? 'Photo' : 'Check-In Photo'}
            </p>
            <button
              type="button"
              onClick={() => setFacing((current) => (current === 'user' ? 'environment' : 'user'))}
              className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              <SwitchCamera size={14} aria-hidden="true" />
              {facing === 'user' ? 'Front camera' : 'Back camera'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setCameraOpen(true)}
            disabled={preparing || loading || checkoutLoading}
            className="flex-1 min-h-[240px] w-full border-3 border-dashed border-slate-200 rounded-md flex flex-col items-center justify-center bg-slate-50/50 relative overflow-hidden transition-all hover:border-indigo-400 hover:bg-indigo-50/30 group/drop disabled:opacity-60"
          >
            {preparing ? (
              <div className="flex flex-col items-center text-slate-500 p-6 text-center" role="status">
                <RefreshCw size={28} className="animate-spin mb-3" aria-hidden="true" />
                <p className="font-bold text-sm">Preparing photo…</p>
              </div>
            ) : preview ? (
              <>
                <img src={preview} alt="Check-in photo preview" className="absolute inset-0 w-full h-full object-cover object-top" />
                <span className="absolute bottom-3 right-3 rounded-md bg-slate-900/70 px-3 py-1.5 text-xs font-semibold text-white flex items-center gap-1.5">
                  <RefreshCw size={13} aria-hidden="true" />
                  Retake
                </span>
              </>
            ) : (
              <div className="flex flex-col items-center text-slate-400 group-hover/drop:text-indigo-500 transition-colors p-6 text-center">
                <div className="w-16 h-16 rounded-md bg-white shadow-sm flex items-center justify-center mb-4 group-hover/drop:scale-110 transition-transform duration-300">
                  <Camera size={32} aria-hidden="true" />
                </div>
                <p className="font-bold text-sm text-slate-600 mb-1">Take a photo</p>
                <p className="text-xs font-medium px-4 leading-relaxed">Opens the camera. Photos cannot be uploaded from your gallery.</p>
              </div>
            )}
          </button>
        </div>

        {fix && !locationStatus && (
          <p className="text-xs font-medium mb-3 flex items-center gap-1.5 text-slate-500">
            <MapPin size={12} className="text-emerald-600" aria-hidden="true" />
            Live location {describeAccuracy(fix) ? `(${describeAccuracy(fix)})` : ''}
            {locationState === 'locating' && <span className="text-slate-400">· refining…</span>}
          </p>
        )}

        {!fix && locationState === 'locating' && !locationStatus && (
          <p role="status" className="text-xs text-indigo-600 font-bold mb-3 flex items-center gap-1">
            <MapPin size={12} aria-hidden="true" /> Finding your location…
          </p>
        )}

        {locationStatus && (
          <p role="status" className="text-xs text-indigo-600 font-bold mb-3 flex items-center gap-1">
            <MapPin size={12} aria-hidden="true" /> {locationStatus}
          </p>
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

      {cameraOpen && (
        <CameraCapture
          facing={facing}
          onFlip={() => setFacing((current) => (current === 'user' ? 'environment' : 'user'))}
          onCapture={handleCapture}
          onClose={() => setCameraOpen(false)}
          autoCapture
        />
      )}

      {missingGenderInstructor && (
        <MissingGenderModal
          instructor={missingGenderInstructor}
          onClose={() => setMissingGenderInstructor(null)}
          onSaved={onInstructorGenderSaved}
        />
      )}

      {reportTarget && (
        <AuditReportModal
          attendanceId={reportTarget.attendanceId}
          instructorName={reportTarget.instructorName}
          saveError={reportTarget.saveError}
          kind={reportTarget.kind}
          onRetryPhoto={reportTarget.retryFile ? retryCheckoutPhoto : undefined}
          onClose={() => {
            setReportTarget(null);
            setMessage({ type: '', text: '' });
          }}
        />
      )}
    </section>
  );
}
