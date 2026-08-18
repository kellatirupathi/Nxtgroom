import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Check, ChevronDown } from 'lucide-react';
import {
  DATE_PRESETS,
  describeRange,
  isCompleteRange,
  rangeForPreset,
  type DatePreset,
  type DateRange,
} from '../attendanceFilters';

interface DateRangeFilterProps {
  preset: DatePreset;
  range: DateRange;
  today: string;
  onChange: (preset: DatePreset, range: DateRange) => void;
}

/**
 * Date filter for the records table.
 *
 * The presets are the questions people actually ask, and a custom range is
 * there for the ones they do not. The panel is rendered through a portal and
 * positioned against the trigger, because the toolbar sits inside the table's
 * horizontally scrolling container, which would otherwise clip it.
 */
export default function DateRangeFilter({ preset, range, today, onChange }: DateRangeFilterProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(range);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const place = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 6, left: rect.left });
  };

  useEffect(() => {
    if (!open) return undefined;
    place();
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // Follows the trigger rather than detaching from it, since the toolbar
    // scrolls with the page.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const choosePreset = (value: DatePreset) => {
    if (value === 'custom') {
      // Seed the pickers with the range already showing, so switching to
      // custom starts from what the user is looking at.
      setDraft(range.from || range.to ? range : rangeForPreset('today', today));
      return;
    }
    onChange(value, rangeForPreset(value, today));
    setOpen(false);
  };

  const applyCustom = () => {
    if (!isCompleteRange(draft, 'custom')) return;
    onChange('custom', draft);
    setOpen(false);
  };

  const draftValid = isCompleteRange(draft, 'custom');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-2.5 text-sm font-medium text-slate-700 outline-none transition-colors hover:bg-slate-50 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
      >
        <CalendarDays size={15} className="text-slate-400" aria-hidden="true" />
        {describeRange(preset, range)}
        <ChevronDown size={14} className="text-slate-400" aria-hidden="true" />
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Filter by date"
          style={{ top: position.top, left: position.left }}
          className="fixed z-[200] w-64 rounded-md border border-slate-200 bg-white p-1.5 shadow-xl"
        >
          {DATE_PRESETS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => choosePreset(option.value)}
              className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-slate-50 ${
                preset === option.value ? 'text-indigo-700' : 'text-slate-700'
              }`}
            >
              {option.label}
              {preset === option.value && <Check size={15} aria-hidden="true" />}
            </button>
          ))}

          <div className="mt-1.5 border-t border-slate-100 p-2.5">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Custom range
            </p>
            <div className="space-y-2">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-slate-500">From</span>
                <input
                  type="date"
                  value={draft.from}
                  max={draft.to || today}
                  onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-slate-500">To</span>
                <input
                  type="date"
                  value={draft.to}
                  min={draft.from || undefined}
                  max={today}
                  onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={applyCustom}
              disabled={!draftValid}
              className="mt-2.5 w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Apply range
            </button>
            {/* Only shown once both ends are set, so it reads as a correction
                rather than an error about an unfinished form. */}
            {draft.from && draft.to && !draftValid && (
              <p role="alert" className="mt-2 text-xs font-medium text-rose-600">
                The start date must be on or before the end date.
              </p>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
