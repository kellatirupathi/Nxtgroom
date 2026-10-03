import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2, MapPin, UserRoundSearch } from 'lucide-react';
import { apiFetch, ApiError } from '../api';
import CameraCapture from './CameraCapture';
import { describeAccuracy, formatCoordinates, getCachedFix, subscribeToLocation, type Fix } from '../lib/location';
import { AttendanceFullScreenContext } from '../lib/attendanceFullscreen';
import { beepsFor, playSuccessBeep } from '../lib/successBeep';
import { BODY_REGIONS_FIELD, type CaptureDetails } from '../lib/bodyRegions';

const RESULT_VISIBLE_MS = 1_200;

type KioskAction = 'CHECK_IN' | 'CHECK_OUT' | 'TOO_EARLY' | 'ALREADY_DONE' | 'NOT_RECOGNISED';

interface KioskResponse {
  action: KioskAction;
  recorded: boolean;
  duplicate?: boolean;
  instructor_name: string | null;
  attendance_id: string | null;
  title: string;
  detail?: string;
  tone: 'success' | 'info' | 'warning';
}

interface KioskResult extends KioskResponse {
  at: number;
}

interface KioskAttendanceProps {
  onExit: () => void;
  facing: 'user' | 'environment';
  onFlip: () => void;
}

export default function KioskAttendance({ onExit, facing, onFlip }: KioskAttendanceProps) {
  const fullScreen = useContext(AttendanceFullScreenContext);
  const [result, setResult] = useState<KioskResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [fix, setFix] = useState<Fix | null>(null);
  const resultTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const submitInFlight = useRef(false);

  useEffect(() => subscribeToLocation(setFix), []);

  useEffect(() => () => {
    clearTimeout(resultTimer.current);
    clearTimeout(errorTimer.current);
  }, []);

  const showResult = useCallback((next: KioskResponse) => {
    if (!next.duplicate && beepsFor(next.action, next.recorded)) playSuccessBeep();
    setResult({ ...next, at: Date.now() });
    clearTimeout(resultTimer.current);
    resultTimer.current = setTimeout(() => setResult(null), RESULT_VISIBLE_MS);
  }, []);

  const submit = useCallback(async (file: File, details?: CaptureDetails) => {
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setSubmitting(true);
    setError('');
    clearTimeout(errorTimer.current);
    try {
      const form = new FormData();
      form.append('file', file);
      if (details?.bodyRegions) form.append(BODY_REGIONS_FIELD, JSON.stringify(details.bodyRegions));
      const currentFix = fix ?? getCachedFix();
      const coordinates = formatCoordinates(currentFix);
      if (coordinates) {
        form.append('location_coordinates', coordinates);
        form.append('location_accuracy_m', String(currentFix?.accuracyMetres ?? ''));
      }
      const response = await apiFetch<KioskResponse>('/api/v2/attendance/auto', {
        method: 'POST',
        body: form,
        timeoutMs: 75_000,
      });
      if (!response.duplicate) showResult(response);
    } catch (requestError) {
      if ((requestError as { status?: number })?.status === 401) return;
      if (requestError instanceof ApiError && requestError.status === 409) {
        showResult({
          action: 'ALREADY_DONE',
          recorded: false,
          instructor_name: null,
          attendance_id: null,
          title: requestError.message,
          detail: 'Nothing was recorded.',
          tone: 'info',
        });
        return;
      }
      const message = requestError instanceof ApiError
        ? requestError.message
        : 'Could not record that. Try again.';
      setError(message);
      errorTimer.current = setTimeout(() => setError(''), 5_000);
    } finally {
      submitInFlight.current = false;
      setSubmitting(false);
    }
  }, [fix, showResult]);

  const toneStyles: Record<KioskResponse['tone'], string> = {
    success: 'bg-emerald-600 text-white',
    info: 'bg-slate-800 text-white',
    warning: 'bg-amber-500 text-white',
  };

  const ToneIcon = result?.tone === 'success'
    ? CheckCircle2
    : result?.tone === 'warning'
      ? UserRoundSearch
      : CircleAlert;

  return (
    <div className={`relative w-full h-full overflow-hidden bg-black ${fullScreen ? '' : 'rounded-md'}`}>
      <div className="pointer-events-none absolute inset-x-3 top-[calc(max(0.75rem,var(--inset-top))+3.75rem)] z-10 flex flex-wrap items-center justify-between gap-2 text-white">
        <h2 className="rounded-md bg-black/50 px-2 py-1 text-sm font-bold shadow-sm">Attendance</h2>
        <p className="flex items-center gap-1.5 rounded-md bg-black/50 px-2 py-1 text-xs font-medium shadow-sm">
          <MapPin size={14} className={fix ? 'text-emerald-400' : 'text-slate-300'} aria-hidden="true" />
          {fix ? `Live location (${describeAccuracy(fix)})` : 'Locating…'}
        </p>
      </div>

      {error && (
        <div role="alert" className="absolute inset-x-3 top-[calc(max(0.75rem,var(--inset-top))+6.5rem)] z-20 rounded-md border border-rose-200 bg-rose-50/95 p-3 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      <div className="absolute inset-0">
        <CameraCapture
          facing={facing}
          autoCapture
          inline
          onFlip={onFlip}
          onCapture={submit}
          onClose={onExit}
        />

        {submitting && !result && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-emerald-600/90"
            role="status"
          >
            <Loader2 size={44} className="animate-spin text-white" aria-hidden="true" />
            <p className="text-xl font-extrabold text-white">Identifying…</p>
          </div>
        )}

        {result && (
          <div
            className={`absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center ${toneStyles[result.tone]}`}
            role="status"
            aria-live="assertive"
          >
            <ToneIcon size={44} className="shrink-0" aria-hidden="true" />
            <p className="text-2xl font-extrabold leading-tight">{result.title}</p>
            {result.detail && (
              <p className="text-sm font-medium opacity-90 max-w-md line-clamp-3">{result.detail}</p>
            )}
            {!result.recorded && (
              <p className="text-[10px] font-bold uppercase tracking-wider opacity-75">
                Nothing was recorded
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
