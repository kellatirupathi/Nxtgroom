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
  matchCount: number;
}

const FIELD = 'h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

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

  // Opens as a dropdown under the Filters button rather than a full-height
  // side panel. A click anywhere outside closes it; the date menu opens above
  // it (z-[200]), so picking a date keeps it open.
  return (
    <>
      <button
        type="button"
        aria-label="Close filters"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-[60] h-full w-full cursor-default bg-slate-900/20 sm:bg-transparent"
      />
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby="attendance-filters-title"
        className="absolute left-0 top-full z-[61] mt-2 flex w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
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

        <div className="max-h-[min(30rem,calc(100dvh-16rem))] space-y-4 overflow-y-auto px-4 py-4">
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

        <div className="flex items-center gap-3 border-t border-slate-200 px-4 py-3">
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
      </div>
    </>
  );
}
