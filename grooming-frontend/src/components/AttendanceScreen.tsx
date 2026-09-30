import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Maximize, RefreshCw, SwitchCamera, User, Users, X } from 'lucide-react';
import BrandedLoader from './BrandedLoader';
import ConfirmDialog from './ConfirmDialog';
import KioskAttendance from './KioskAttendance';
import { useAttendanceFullScreen } from './useAttendanceFullScreen';
import { AttendanceFullScreenContext } from '../lib/attendanceFullscreen';
import { isChunkLoadError, memoizedImport, reloadForNewDeployment } from '../lib/chunkRecovery';
import { preloadFullBodyDetector } from '../lib/fullBodyDetector';

/**
 * The group screen's code, fetched at most once per page.
 *
 * It is fetched in the background shortly after Attendance opens, not when the
 * tab is first clicked. That makes the first click instant instead of a
 * loading screen, and it means the code is already in the page before any
 * later deployment can remove the file it came from: a tablet opened in the
 * morning can switch to Group in the afternoon however many deployments
 * happened in between.
 */
const loadGroupScreen = memoizedImport(() => import('./GroupKioskAttendance'));

/** After the one-person camera has started, so the two do not compete. */
const GROUP_PRELOAD_DELAY_MS = 1_500;

/**
 * Set just before the page reloads for a new deployment, so it comes back on
 * the group screen somebody was opening rather than on the default.
 */
const REOPEN_GROUP_KEY = 'facultytrack:reopen-group';

function reopenGroupRequested(): boolean {
  try {
    return sessionStorage.getItem(REOPEN_GROUP_KEY) === '1';
  } catch {
    return false;
  }
}

function clearReopenGroup(): void {
  try {
    sessionStorage.removeItem(REOPEN_GROUP_KEY);
  } catch {
    // Nothing was stored, so nothing to clear.
  }
}

type CaptureMode = 'single' | 'group';

interface AttendanceScreenProps {
  onExit: () => void;
}

interface GroupScreenBoundaryProps {
  onRetry: () => void;
  children: ReactNode;
}

interface GroupScreenBoundaryState {
  failed: boolean;
}

/**
 * Keeps a failure of the group screen inside its panel.
 *
 * Without this, a group screen that failed to open took the whole app down to
 * "FacultyTrack could not load", including the one-person camera and the
 * navigation. Now the panel says so and offers another try, and everything
 * around it keeps working.
 *
 * A download failure - the code deployed away - is fixed by loading the page
 * again, so that is done at once rather than asked for, once a minute at most.
 */
class GroupScreenBoundary extends Component<GroupScreenBoundaryProps, GroupScreenBoundaryState> {
  constructor(props: GroupScreenBoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): GroupScreenBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error('Group attendance could not open', error);
    if (!isChunkLoadError(error)) return;
    try {
      sessionStorage.setItem(REOPEN_GROUP_KEY, '1');
    } catch {
      // Without storage the page cannot remember to reopen the group screen.
    }
    if (!reloadForNewDeployment()) clearReopenGroup();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="h-full flex flex-col items-center justify-center gap-3 rounded-md border border-slate-200 bg-white p-6 text-center"
      >
        <p className="text-sm font-bold text-slate-700">Group attendance could not open.</p>
        <p className="text-xs text-slate-500">Check the connection and try again. One-person attendance still works.</p>
        <button
          type="button"
          onClick={this.props.onRetry}
          className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700"
        >
          <RefreshCw size={14} aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }
}

/**
 * Chooses between photographing one person and photographing several.
 *
 * Single is the default and stays the default. It is what every college's
 * attendance currently runs on, it is the mode that handles somebody walking up
 * to a tablet alone, and nothing about opening this screen should change for
 * anybody who has not asked for the other one. The one exception is a page
 * reloaded while somebody was opening Group, which returns them to Group.
 *
 * Group is a different screen rather than a setting on the same one: a
 * different camera gate, a different request, and a list of outcomes instead of
 * a single answer. The toggle swaps which is mounted, so the two never share a
 * camera, a hold, or a moment of state — the screen that was not chosen is not
 * running.
 */
export default function AttendanceScreen({ onExit }: AttendanceScreenProps) {
  // Read without clearing, because React may run this twice in development;
  // the flag is cleared once the screen has mounted.
  const [mode, setMode] = useState<CaptureMode>(() => (reopenGroupRequested() ? 'group' : 'single'));
  const [groupAttempt, setGroupAttempt] = useState(0);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const flipCamera = () => setFacing((current) => current === 'user' ? 'environment' : 'user');
  // A lazy component remembers a failed download for good, so a retry needs a
  // new one; the import underneath is shared and fetched once.
  const [GroupScreen, setGroupScreen] = useState(() => lazy(loadGroupScreen));

  // As the screen opens, behind the start card and the camera starting rather
  // than after them, so the face boxes are ready when somebody steps up.
  useEffect(() => {
    preloadFullBodyDetector();
  }, []);

  useEffect(() => {
    clearReopenGroup();
    const timer = setTimeout(() => {
      // A failure here is quiet: clicking Group tries again, and says so.
      loadGroupScreen().catch(() => {});
    }, GROUP_PRELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const retryGroup = () => {
    setGroupScreen(() => lazy(loadGroupScreen));
    setGroupAttempt((attempt) => attempt + 1);
  };

  const fullScreen = useAttendanceFullScreen();
  const [confirmingExit, setConfirmingExit] = useState(false);

  // Cleared on the way in: a question left open when Esc ended full screen
  // must not greet the next one.
  const startFullScreen = () => {
    setConfirmingExit(false);
    fullScreen.enter();
  };

  if (fullScreen.offered) {
    return (
      <FullScreenPrompt
        supported={fullScreen.supported}
        onStart={startFullScreen}
        onDecline={fullScreen.decline}
      />
    );
  }

  const tab = (value: CaptureMode, label: string, Icon: typeof User) => (
    <button
      key={value}
      type="button"
      onClick={() => setMode(value)}
      aria-pressed={mode === value}
      className={`flex min-h-11 items-center gap-1.5 rounded-md px-3 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:text-sm ${
        mode === value ? 'bg-indigo-600 text-white' : 'text-white hover:bg-white/15'
      }`}
    >
      <Icon size={16} className="hidden sm:block" aria-hidden="true" />
      {label}
    </button>
  );

  return (
    // The same element in and out of full screen, only restyled, so the camera
    // underneath keeps running rather than starting again. Fixed over the
    // window is what hides the menus; the browser's own full screen, where it
    // has one, hides its address bar as well.
    <div
      className={fullScreen.active
        ? 'fixed inset-0 z-[55] overflow-hidden bg-black'
        : 'relative w-full h-full overflow-hidden rounded-md bg-black'}
    >
      {/* Controls float above the preview without reserving any camera height. */}
      <div className="pointer-events-none absolute inset-x-0 top-[max(0.75rem,var(--inset-top))] z-30 flex items-start justify-between gap-2 px-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]">
        <div className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-lg border border-white/25 bg-black/50 p-1 shadow-lg backdrop-blur-sm" role="group" aria-label="Attendance capture mode">
          {tab('single', 'Single', User)}
          {tab('group', 'Group', Users)}
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
          {!fullScreen.active && (
            <button
              type="button"
              onClick={startFullScreen}
              aria-label="Full screen"
              title="Full screen"
              className="flex h-11 w-11 items-center justify-center rounded-full border border-white/30 bg-black/50 text-white shadow-lg backdrop-blur-sm hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <Maximize size={20} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={flipCamera}
            aria-label={facing === 'user' ? 'Switch to back camera' : 'Switch to front camera'}
            title="Flip camera"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-white/30 bg-black/50 text-white shadow-lg backdrop-blur-sm hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <SwitchCamera size={22} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => fullScreen.active ? setConfirmingExit(true) : onExit()}
            aria-label={fullScreen.active ? 'Exit full screen' : 'Close attendance camera'}
            title={fullScreen.active ? 'Exit full screen' : 'Close attendance camera'}
            className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-white/50 bg-black/50 text-white shadow-lg backdrop-blur-sm hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <X size={24} strokeWidth={2.4} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="absolute inset-0">
        <AttendanceFullScreenContext.Provider value={fullScreen.active}>
          {mode === 'single' ? (
            <KioskAttendance onExit={onExit} facing={facing} onFlip={flipCamera} />
          ) : (
            <GroupScreenBoundary key={groupAttempt} onRetry={retryGroup}>
              <Suspense fallback={<BrandedLoader label="Loading group attendance" />}>
                <GroupScreen facing={facing} />
              </Suspense>
            </GroupScreenBoundary>
          )}
        </AttendanceFullScreenContext.Provider>
      </div>

      {/* Asked first: an instructor leaning on the corner of the tablet should
          not be able to bring the browser back by accident. */}
      <ConfirmDialog
        open={confirmingExit && fullScreen.active}
        title="Exit full screen?"
        message={`${fullScreen.browser ? 'The browser bar and menus come back.' : 'The menus come back.'} Attendance keeps working, and you can go full screen again with one tap.`}
        confirmLabel="Exit"
        cancelLabel="Stay in full screen"
        onConfirm={() => {
          setConfirmingExit(false);
          fullScreen.exit();
        }}
        onCancel={() => setConfirmingExit(false)}
      />
    </div>
  );
}

interface FullScreenPromptProps {
  supported: boolean;
  onStart: () => void;
  onDecline: () => void;
}

/**
 * What Attendance opens on in a browser. Full screen needs a tap, so the tap
 * that starts attendance is the one that asks for it. The camera starts once
 * either button is pressed, so nobody is photographed behind the card.
 */
function FullScreenPrompt({ supported, onStart, onDecline }: FullScreenPromptProps) {
  return (
    <div className="w-full h-full min-h-[24rem] flex items-center justify-center rounded-md bg-slate-800 p-4 sm:p-8">
      <section
        aria-labelledby="attendance-fullscreen-title"
        className="w-full max-w-md flex flex-col items-center gap-3.5 rounded-xl bg-white px-6 py-8 text-center shadow-xl sm:px-8 sm:py-9"
      >
        <span className="flex h-[72px] w-[72px] items-center justify-center rounded-2xl bg-indigo-100 text-indigo-700">
          <Maximize size={34} aria-hidden="true" />
        </span>
        <h2 id="attendance-fullscreen-title" className="text-2xl font-extrabold text-slate-900">
          Start attendance
        </h2>
        <p className="text-base leading-relaxed text-slate-600">
          {supported
            ? 'The camera fills the whole screen. The browser bar and menus are hidden until you close it.'
            : 'The camera fills the screen and the menus are hidden until you close it.'}
        </p>
        <button
          type="button"
          onClick={onStart}
          className="mt-2 flex h-14 w-full items-center justify-center gap-2.5 rounded-lg bg-indigo-600 text-lg font-bold text-white transition-colors hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
        >
          <Maximize size={20} aria-hidden="true" />
          Start full screen
        </button>
        <button
          type="button"
          onClick={onDecline}
          className="h-11 px-4 text-[15px] font-semibold text-slate-600 transition-colors hover:text-slate-800"
        >
          Not now
        </button>
      </section>
    </div>
  );
}
