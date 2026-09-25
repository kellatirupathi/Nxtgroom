import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { RefreshCw, User, Users } from 'lucide-react';
import BrandedLoader from './BrandedLoader';
import KioskAttendance from './KioskAttendance';
import { isChunkLoadError, memoizedImport, reloadForNewDeployment } from '../lib/chunkRecovery';

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
  // A lazy component remembers a failed download for good, so a retry needs a
  // new one; the import underneath is shared and fetched once.
  const [GroupScreen, setGroupScreen] = useState(() => lazy(loadGroupScreen));

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

  const tab = (value: CaptureMode, label: string, Icon: typeof User) => (
    <button
      key={value}
      type="button"
      onClick={() => setMode(value)}
      aria-pressed={mode === value}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition-colors ${
        mode === value
          ? 'bg-indigo-600 text-white'
          : 'bg-white text-slate-600 hover:bg-slate-100'
      }`}
    >
      <Icon size={14} aria-hidden="true" />
      {label}
    </button>
  );

  return (
    <div className="w-full h-full flex flex-col">
      {/* One row, above the screen rather than inside it, so neither camera has
          to know the other exists. */}
      <div className="mb-2 shrink-0 flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 p-1 w-fit">
        {tab('single', 'One person', User)}
        {tab('group', 'Group', Users)}
      </div>

      <div className="flex-1 min-h-0">
        {mode === 'single' ? (
          <KioskAttendance onExit={onExit} />
        ) : (
          <GroupScreenBoundary key={groupAttempt} onRetry={retryGroup}>
            <Suspense fallback={<BrandedLoader label="Loading group attendance" />}>
              <GroupScreen />
            </Suspense>
          </GroupScreenBoundary>
        )}
      </div>
    </div>
  );
}
