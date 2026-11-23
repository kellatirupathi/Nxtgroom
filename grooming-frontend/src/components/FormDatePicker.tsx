import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  calendarDays,
  displayDate,
  longDate,
  MONTH_TITLES,
  shiftMonth,
  WEEKDAY_SHORT,
} from '../lib/instituteForm';

interface FormDatePickerProps {
  id: string;
  value: string;
  today: string;
  min: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

function monthOf(key: string): { year: number; month: number } {
  const [year, month] = key.split('-').map(Number);
  return { year, month };
}

// A calendar that opens under the date: the month with arrows to move
// between months, today outlined, the chosen day filled and future days
// greyed out.
export default function FormDatePicker({ id, value, today, min, disabled = false, onChange }: FormDatePickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => monthOf(value || today));
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (!open) setView(monthOf(value || today));
    setOpen((current) => !current);
  };

  const choose = (key: string) => {
    if (key > today || key < min) return;
    setOpen(false);
    onChange(key);
  };

  const todayMonth = monthOf(today);
  const minMonth = monthOf(min);
  const atLatest = view.year > todayMonth.year || (view.year === todayMonth.year && view.month >= todayMonth.month);
  const atEarliest = view.year < minMonth.year || (view.year === minMonth.year && view.month <= minMonth.month);

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Date: ${longDate(value)}. Change the date`}
        className="mt-1 flex h-10 w-52 max-w-full items-center justify-between gap-3 border-0 border-b border-slate-400 bg-transparent px-0 text-left text-base text-slate-900 outline-none hover:border-slate-600 focus-visible:border-b-2 focus-visible:border-indigo-600 disabled:opacity-60"
      >
        <span className="tabular-nums">{displayDate(value)}</span>
        <CalendarDays size={18} className="shrink-0 text-slate-600" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose a date"
          className="absolute left-0 top-full z-30 mt-2 w-[19rem] max-w-[calc(100vw-2.5rem)] rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
        >
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setView((current) => shiftMonth(current.year, current.month, -1))}
              disabled={atEarliest}
              aria-label="Previous month"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-30"
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <p className="text-base font-bold text-slate-900" aria-live="polite">
              {MONTH_TITLES[view.month - 1]} {view.year}
            </p>
            <button
              type="button"
              onClick={() => setView((current) => shiftMonth(current.year, current.month, 1))}
              disabled={atLatest}
              aria-label="Next month"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-30"
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>

          <div className="mt-3 grid grid-cols-7 gap-1 text-center" role="grid" aria-label={`${MONTH_TITLES[view.month - 1]} ${view.year}`}>
            {WEEKDAY_SHORT.map((name) => (
              <span key={name} className="py-1 text-xs font-medium text-slate-400" role="columnheader">{name}</span>
            ))}
            {calendarDays(view.year, view.month).map((day) => {
              const selected = day.key === value;
              const isToday = day.key === today;
              const unavailable = day.key > today || day.key < min;
              return (
                <button
                  key={day.key}
                  type="button"
                  onClick={() => choose(day.key)}
                  disabled={unavailable}
                  aria-label={longDate(day.key)}
                  aria-pressed={selected}
                  aria-current={isToday ? 'date' : undefined}
                  className={`mx-auto flex h-9 w-9 items-center justify-center rounded-lg text-sm tabular-nums transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                    selected
                      ? 'bg-indigo-600 font-bold text-white'
                      : unavailable
                        ? 'cursor-not-allowed text-slate-300'
                        : isToday
                          ? 'font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-400 hover:bg-indigo-50'
                          : day.inMonth
                            ? 'text-slate-800 hover:bg-slate-100'
                            : 'text-slate-400 hover:bg-slate-100'
                  }`}
                >
                  {day.day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
