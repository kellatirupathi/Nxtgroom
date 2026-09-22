import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2, MapPin, UserRoundSearch, Users } from 'lucide-react';
import { apiFetch, ApiError } from '../api';
import GroupCameraCapture from './GroupCameraCapture';
import { describeAccuracy, formatCoordinates, getCachedFix, subscribeToLocation, type Fix } from '../lib/location';

/**
 * How long a group's results stay on screen.
 *
 * Longer than the single-person panel's second and a bit, because there are
 * several names to find yours in rather than one to read. Still short enough
 * that the next group is not kept waiting behind it, and the camera runs
 * underneath the whole time.
 */
const RESULT_VISIBLE_MS = 5_000;

type KioskAction = 'CHECK_IN' | 'CHECK_OUT' | 'TOO_EARLY' | 'ALREADY_DONE' | 'UNIDENTIFIED';

interface GroupPerson {
  action: KioskAction;
  recorded: boolean;
  instructor_name: string | null;
  attendance_id: string | null;
  title: string;
  detail?: string;
  tone: 'success' | 'info' | 'warning';
  similarity?: number | null;
  /** Where in the photograph this person stood, as ratios of the frame. */
  position?: { left: number; top: number; width: number; height: number };
}

interface GroupResponse {
  detected: number;
  recorded: number;
  /** A trailing frame from a moment the tablet has already answered. */
  duplicate?: boolean;
  people: GroupPerson[];
  detail?: string;
}

interface GroupResult extends GroupResponse {
  at: number;
}

/**
 * Attendance for several people at once.
 *
 * One photograph, one row per person, and each row is that person's own
 * outcome: their arrival, their departure, or the fact that nobody recognised
 * them. The screen has to name everybody rather than summarise, because six
 * people walking away from a tablet that said "4 recorded" have no way to tell
 * which two of them it meant.
 *
 * Nothing here decides anything. Every name, every action and every refusal
 * comes back from the server, which applies the same rules to each person as
 * the single-person screen applies to one.
 */
export default function GroupKioskAttendance() {
  const [result, setResult] = useState<GroupResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [fix, setFix] = useState<Fix | null>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const resultTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const submitInFlight = useRef(false);

  useEffect(() => subscribeToLocation(setFix), []);

  useEffect(() => () => {
    clearTimeout(resultTimer.current);
    clearTimeout(errorTimer.current);
  }, []);

  const showResult = useCallback((next: GroupResponse) => {
    setResult({ ...next, at: Date.now() });
    clearTimeout(resultTimer.current);
    resultTimer.current = setTimeout(() => setResult(null), RESULT_VISIBLE_MS);
  }, []);

  const submit = useCallback(async (file: File) => {
    // React state is not synchronous; this ref closes the gap in which a second
    // capture arrives before `submitting` has caused a render.
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
        // Nobody was found, or nobody was usable. The server says which, and
        // that sentence is more use than an empty list of names.
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
    <div className="w-full h-full flex flex-col">
      <div className="mb-2 shrink-0 flex items-center justify-between gap-4">
        <h2 className="text-lg font-extrabold text-slate-800 flex items-center gap-2">
          <Users size={18} className="text-indigo-600" aria-hidden="true" />
          Group attendance
        </h2>
        <p className="text-xs font-medium text-slate-500 flex items-center gap-1.5 shrink-0">
          <MapPin size={14} className={fix ? 'text-emerald-600' : 'text-slate-400'} aria-hidden="true" />
          {fix ? `Live location (${describeAccuracy(fix)})` : 'Locating…'}
        </p>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700 shrink-0">
          {error}
        </div>
      )}

      <div className="relative flex-1 min-h-0 rounded-md overflow-hidden border border-slate-200 bg-black">
        <GroupCameraCapture
          facing={facing}
          onFlip={() => setFacing((current) => (current === 'user' ? 'environment' : 'user'))}
          onCapture={submit}
        />

        {submitting && !result && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-emerald-600/90" role="status">
            <Loader2 size={44} className="animate-spin text-white" aria-hidden="true" />
            <p className="text-xl font-extrabold text-white">Identifying everyone…</p>
            <p className="text-sm font-medium text-white/80">This takes a moment for a group.</p>
          </div>
        )}

        {/* One row per person, over a camera that never stopped. Everybody has
            to be named: a group told only how many were recorded cannot tell
            which of them still needs to try again. */}
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
                    {!person.recorded && (
                      <span className="text-[10px] font-bold uppercase tracking-wider opacity-75 shrink-0">
                        Not recorded
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* Somebody standing in the photograph whom the detector never
                found would otherwise vanish without trace. */}
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
