import { useEffect, useRef } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import DateRangeFilter from './DateRangeFilter';
import {
  ESCALATION_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
  type DatePreset,
  type DateRange,
  type EscalationFilter,
} from '../attendanceFilters';
import type { AttendanceStatus } from '../types';

interface AttendanceFilterDrawerProps {
  open: boolean;
  onClose: () => void;
  preset: DatePreset;
  range: DateRange;
  today: string;
  onRangeChange: (preset: DatePreset, range: DateRange) => void;
  college: string;
  colleges: string[];
  onCollegeChange: (value: string) => void;
  role: string;
  roles: string[];
  onRoleChange: (value: string) => void;
  status: AttendanceStatus | '';
  onStatusChange: (value: AttendanceStatus | '') => void;
  escalation: EscalationFilter;
  onEscalationChange: (value: EscalationFilter) => void;
  onClearAll: () => void;
  /** Rows the current filters leave, so the button says what closing will show. */
  matchCount: number;
}

const FIELD = 'h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

/**
 * The Daily Records filters, in a panel down the right-hand side.
 *
 * Every filter applies the moment it changes - the table behind the panel is
 * the preview - so there is no Apply step to forget. The footer button closes
 * the panel and says how many records the filters leave.
 *
 * Closed by the backdrop, the X, the footer button or Escape. Not by a
 * document-wide outside click: the date filter's menu is portalled to the body,
 * so a click in it is "outside" this panel, and choosing a date would close it.
 */
export default function AttendanceFilterDrawer({
  open,
  onClose,
  preset,
  range,
  today,
  onRangeChange,
  college,
  colleges,
  onCollegeChange,
  role,
  roles,
  onRoleChange,
  status,
  onStatusChange,
  escalation,
  onEscalationChange,
  onClearAll,
  matchCount,
}: AttendanceFilterDrawerProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-labelledby="attendance-filters-title">
      <button
        type="button"
        aria-label="Close filters"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-slate-900/40"
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h3 id="attendance-filters-title" className="flex items-center gap-2 text-base font-bold text-slate-800">
            <SlidersHorizontal size={18} className="text-indigo-600" aria-hidden="true" />
            Filters
          </h3>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close filters"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <div>
            <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-slate-500">Date</p>
            <DateRangeFilter preset={preset} range={range} today={today} onChange={onRangeChange} />
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Institute</span>
            <select value={college} onChange={(event) => onCollegeChange(event.target.value)} className={FIELD}>
              <option value="">All institutes</option>
              {colleges.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Role</span>
            <select value={role} onChange={(event) => onRoleChange(event.target.value)} className={FIELD}>
              <option value="">All roles</option>
              {roles.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Status</span>
            <select
              value={status}
              onChange={(event) => onStatusChange(event.target.value as AttendanceStatus | '')}
              className={FIELD}
            >
              <option value="">All statuses</option>
              {STATUS_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Escalation</span>
            <select
              value={escalation}
              onChange={(event) => onEscalationChange(event.target.value as EscalationFilter)}
              className={FIELD}
            >
              <option value="">All instructors</option>
              {ESCALATION_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex items-center gap-3 border-t border-slate-200 px-5 py-4">
          <button
            type="button"
            onClick={onClearAll}
            className="h-10 flex-1 rounded-md border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-10 flex-1 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
          >
            Show {matchCount} {matchCount === 1 ? 'record' : 'records'}
          </button>
        </div>
      </aside>
    </div>
  );
}
