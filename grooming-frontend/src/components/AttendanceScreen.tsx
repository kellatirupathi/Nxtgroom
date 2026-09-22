import { lazy, Suspense, useState } from 'react';
import { User, Users } from 'lucide-react';
import BrandedLoader from './BrandedLoader';
import KioskAttendance from './KioskAttendance';

const GroupKioskAttendance = lazy(() => import('./GroupKioskAttendance'));

type CaptureMode = 'single' | 'group';

interface AttendanceScreenProps {
  onExit: () => void;
}

/**
 * Chooses between photographing one person and photographing several.
 *
 * Single is the default and stays the default. It is what every college's
 * attendance currently runs on, it is the mode that handles somebody walking up
 * to a tablet alone, and nothing about opening this screen should change for
 * anybody who has not asked for the other one.
 *
 * Group is a different screen rather than a setting on the same one: a
 * different camera gate, a different request, and a list of outcomes instead of
 * a single answer. The toggle swaps which is mounted, so the two never share a
 * camera, a hold, or a moment of state — the screen that was not chosen is not
 * running.
 *
 * Loaded on demand, so the pose model and the group screen are fetched by the
 * tablets that use them rather than by everybody who opens Attendance.
 */
export default function AttendanceScreen({ onExit }: AttendanceScreenProps) {
  const [mode, setMode] = useState<CaptureMode>('single');

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
          <Suspense fallback={<BrandedLoader label="Loading group attendance" />}>
            <GroupKioskAttendance />
          </Suspense>
        )}
      </div>
    </div>
  );
}
