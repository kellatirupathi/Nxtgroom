import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2, MapPin, UserRoundSearch } from 'lucide-react';
import { apiFetch, ApiError } from '../api';
import GroupCameraCapture from './GroupCameraCapture';
import { describeAccuracy, formatCoordinates, getCachedFix, subscribeToLocation, type Fix } from '../lib/location';
import { formatAttendanceTime } from '../attendanceFilters';
import { AttendanceFullScreenContext } from '../lib/attendanceFullscreen';
import { beepsFor, playSuccessBeep } from '../lib/successBeep';

const RESULT_VISIBLE_MS = 5_000;

type KioskAction = 'CHECK_IN' | 'CHECK_OUT' | 'TOO_EARLY' | 'ALREADY_DONE' | 'NOT_RECOGNISED';

interface GroupPerson {
  action: KioskAction;
  recorded: boolean;
  instructor_name: string | null;
  attendance_id: string | null;
  title: string;
  detail?: string;
  tone: 'success' | 'info' | 'warning';
  similarity?: number | null;
  position?: { left: number; top: number; width: number; height: number };
  recorded_at?: string | null;
  check_in_time?: string | null;
}

interface GroupResponse {
  detected: number;
  recorded: number;
  duplicate?: boolean;
  people: GroupPerson[];
  detail?: string;
}

interface GroupResult extends GroupResponse {
  at: number;
}

export default function GroupKioskAttendance({ facing }: { facing: 'user' | 'environment' }) {
  const fullScreen = useContext(AttendanceFullScreenContext);
  const [result, setResult] = useState<GroupResult | null>(null);
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

  const showResult = useCallback((next: GroupResponse) => {
    if (!next.duplicate && next.people.some((person) => beepsFor(person.action, person.recorded))) playSuccessBeep();
    setResult({ ...next, at: Date.now() });
    clearTimeout(resultTimer.current);
    resultTimer.current = setTimeout(() => setResult(null), RESULT_VISIBLE_MS);
  }, []);

  const submit = useCallback(async (file: File) => {
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setSubmitting(true);
    setError('');
    clearTimeout(errorTimer.current);
    try {
      const form = new FormData();
      form.append('file', file);
      const currentFix = fix ?? getCachedFix();
      const coordinates = formatCoordinates(currentFix);
      if (coordinates) {
        form.append('location_coordinates', coordinates);
        form.append('location_accuracy_m', String(currentFix?.accuracyMetres ?? ''));
      }
      const response = await apiFetch<GroupResponse>('/api/v2/attendance/auto/group', {
        method: 'POST',
        body: form,
        timeoutMs: 75_000,
      });
      if (response.duplicate) return;
      if (!response.people?.length) {
        setError(response.detail || 'Nobody could be identified from that photo.');
        errorTimer.current = setTimeout(() => setError(''), 5_000);
        return;
      }
      showResult(response);
    } catch (requestError) {
      if ((requestError as { status?: number })?.status === 401) return;
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

  const rowStyles: Record<GroupPerson['tone'], string> = {
    success: 'bg-emerald-600/95 text-white',
    info: 'bg-slate-800/95 text-white',
    warning: 'bg-amber-500/95 text-white',
  };

  const RowIcon = (tone: GroupPerson['tone']) => (
    tone === 'success' ? CheckCircle2 : tone === 'warning' ? UserRoundSearch : CircleAlert
  );

  return (
    <div className={`relative w-full h-full overflow-hidden bg-black ${fullScreen ? '' : 'rounded-md'}`}>
      <div className="pointer-events-none absolute inset-x-3 top-[calc(max(0.75rem,var(--inset-top))+3.75rem)] z-10 flex flex-wrap items-center justify-between gap-2 text-white">
        <h2 className="rounded-md bg-black/50 px-2 py-1 text-sm font-bold shadow-sm">Group attendance</h2>
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
        <GroupCameraCapture
          facing={facing}
          onCapture={submit}
        />

        {submitting && !result && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-emerald-600/90" role="status">
            <Loader2 size={44} className="animate-spin text-white" aria-hidden="true" />
            <p className="text-xl font-extrabold text-white">Identifying everyone…</p>
            <p className="text-sm font-medium text-white/80">This takes a moment for a group.</p>
          </div>
        )}

        {result && (
          <div
            className="absolute inset-0 flex flex-col bg-slate-900/95 px-4 py-4 overflow-y-auto"
            role="status"
            aria-live="assertive"
          >
            <p className="text-sm font-bold text-white/70 mb-3 shrink-0">
              {result.recorded} of {result.people.length} recorded
            </p>
            <ul className="flex flex-col gap-2">
              {result.people.map((person, index) => {
                const Icon = RowIcon(person.tone);
                const when = person.recorded_at || person.check_in_time || null;
                const timeLabel = when ? formatAttendanceTime(when) : null;
                return (
                  <li
                    key={person.attendance_id || `${person.title}-${index}`}
                    className={`flex items-center gap-3 rounded-lg px-4 py-3 ${rowStyles[person.tone]}`}
                  >
                    <Icon size={22} className="shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-extrabold leading-tight truncate">{person.title}</p>
                      {person.detail && (
                        <p className="text-xs font-medium opacity-90 truncate">{person.detail}</p>
                      )}
                    </div>
                    {timeLabel && timeLabel !== '--' && (
                      <span className="text-sm font-bold tabular-nums shrink-0">{timeLabel}</span>
                    )}
                    {!person.recorded && (
                      <span className="text-[10px] font-bold uppercase tracking-wider opacity-75 shrink-0">
                        Not recorded
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {result.detected > result.people.length && (
              <p className="mt-3 text-xs font-semibold text-amber-300 shrink-0">
                {result.detected - result.people.length} more {result.detected - result.people.length === 1 ? 'face was' : 'faces were'} seen
                but could not be used. Stand closer and try again.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
