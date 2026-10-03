import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Maximize, RefreshCw, SwitchCamera, User, Users, X } from 'lucide-react';
import BrandedLoader from './BrandedLoader';
import ConfirmDialog from './ConfirmDialog';
import KioskAttendance from './KioskAttendance';
import { useAttendanceFullScreen } from './useAttendanceFullScreen';
import { AttendanceFullScreenContext } from '../lib/attendanceFullscreen';
import { isChunkLoadError, memoizedImport, reloadForNewDeployment } from '../lib/chunkRecovery';
import { preloadFullBodyDetector } from '../lib/fullBodyDetector';
import { armBeepUnlock } from '../lib/successBeep';

const loadGroupScreen = memoizedImport(() => import('./GroupKioskAttendance'));

const GROUP_PRELOAD_DELAY_MS = 1_500;

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

export default function AttendanceScreen({ onExit }: AttendanceScreenProps) {
  const [mode, setMode] = useState<CaptureMode>(() => (reopenGroupRequested() ? 'group' : 'single'));
  const [groupAttempt, setGroupAttempt] = useState(0);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const flipCamera = () => setFacing((current) => current === 'user' ? 'environment' : 'user');
  const [GroupScreen, setGroupScreen] = useState(() => lazy(loadGroupScreen));

  useEffect(() => {
    preloadFullBodyDetector();
  }, []);

  useEffect(() => armBeepUnlock(), []);

  useEffect(() => {
    clearReopenGroup();
    const timer = setTimeout(() => {
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
    <div
      className={fullScreen.active
        ? 'fixed inset-0 z-[55] overflow-hidden bg-black'
        : 'relative w-full h-full overflow-hidden rounded-md bg-black'}
    >
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
