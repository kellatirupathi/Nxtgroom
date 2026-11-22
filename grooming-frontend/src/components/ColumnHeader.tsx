import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Filter } from 'lucide-react';
import type { ColumnSort } from '../lib/tableSort';

// A table header with a sort toggle and a funnel that opens that column's
// filter in a small panel just below the header. The panel is portalled so a
// scrolling table cannot clip it; a click outside, Esc or scrolling the page
// closes it. Date menus inside it open above it (z-[200]).

const PANEL_WIDTH = 256;

interface ColumnHeaderProps {
  label: string;
  sortKey?: string;
  sort?: ColumnSort | null;
  onSort?: (key: string) => void;
  filterActive?: boolean;
  filter?: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
}

export default function ColumnHeader({
  label,
  sortKey,
  sort = null,
  onSort,
  filterActive = false,
  filter,
  align = 'left',
}: ColumnHeaderProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const sorted = Boolean(sortKey) && sort?.key === sortKey;
  const SortIcon = sorted ? (sort?.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const maxLeft = window.innerWidth - PANEL_WIDTH - 8;
    const left = align === 'right' ? rect.right - PANEL_WIDTH : rect.left - 8;
    setPosition({ top: rect.bottom + 8, left: Math.max(8, Math.min(left, maxLeft)) });
  }, [open, align]);

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onScroll = (event: Event) => {
      if (panelRef.current && event.target instanceof Node && panelRef.current.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    panelRef.current?.querySelector<HTMLElement>('input')?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const sortState = sorted ? (sort?.direction === 'asc' ? 'sorted A to Z / low to high' : 'sorted Z to A / high to low') : 'not sorted';

  return (
    <span className={`inline-flex items-center gap-1 ${align === 'right' ? 'justify-end' : ''}`}>
      {sortKey && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          aria-label={`Sort by ${label} (${sortState})`}
          className={`inline-flex items-center gap-1 whitespace-nowrap rounded uppercase tracking-wider focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${sorted ? 'text-indigo-700' : 'hover:text-slate-700'}`}
        >
          {label}
          <SortIcon size={12} className={sorted ? '' : 'text-slate-400'} aria-hidden="true" />
        </button>
      ) : (
        <span className="whitespace-nowrap">{label}</span>
      )}
      {filter && (
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={filterActive ? `Filter ${label} (filtered)` : `Filter ${label}`}
          title={`Filter ${label.toLowerCase()}`}
          className={`rounded p-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${filterActive ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
        >
          <Filter size={12} fill={filterActive ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>
      )}
      {open && filter && createPortal(
        <>
          <button
            type="button"
            aria-label="Close filter"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[150] h-full w-full cursor-default bg-transparent"
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-label={`Filter ${label}`}
            style={{ top: position.top, left: position.left, width: PANEL_WIDTH }}
            className="fixed z-[151] rounded-lg border border-slate-200 bg-white p-2 text-left text-sm font-normal normal-case tracking-normal text-slate-700 shadow-xl"
          >
            {filter(() => setOpen(false))}
          </div>
        </>,
        document.body,
      )}
    </span>
  );
}

interface OptionsFilterProps<V extends string> {
  value: V | '';
  options: ReadonlyArray<{ value: V; label: string }>;
  onChange: (value: V | '') => void;
  close: () => void;
  allLabel?: string;
}

// One choice from a list, with "All" to clear it.
export function OptionsFilter<V extends string>({ value, options, onChange, close, allLabel = 'All' }: OptionsFilterProps<V>) {
  const [query, setQuery] = useState('');
  const term = query.trim().toLowerCase();
  const shown = term ? options.filter((option) => option.label.toLowerCase().includes(term)) : options;
  const choose = (next: V | '') => {
    onChange(next);
    close();
  };
  const row = (key: string, label: string, selected: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm ${selected ? 'bg-indigo-50 font-semibold text-indigo-700' : 'text-slate-700 hover:bg-slate-50'}`}
    >
      <Check size={14} className={selected ? 'shrink-0' : 'invisible shrink-0'} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
    </button>
  );
  return (
    <div className="flex flex-col gap-1">
      {options.length > 8 && (
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search…"
          aria-label="Search options"
          className="mb-1 h-9 w-full rounded-md border border-slate-300 px-2.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
        />
      )}
      <div role="listbox" className="flex max-h-64 flex-col overflow-y-auto">
        {!term && row('__all', allLabel, value === '', () => choose(''))}
        {shown.map((option) => row(option.value, option.label, option.value === value, () => choose(option.value)))}
        {shown.length === 0 && <p className="px-2.5 py-2 text-sm text-slate-400">No matches</p>}
      </div>
    </div>
  );
}

function FilterActions({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex justify-between">
      <button type="button" onClick={onClear} className="rounded-md px-2.5 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-100">Clear</button>
      <button type="submit" className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700">Done</button>
    </div>
  );
}

interface TextFilterProps {
  value: string;
  onChange: (value: string) => void;
  close: () => void;
  placeholder?: string;
}

// Rows whose value contains the typed text; the table updates as you type.
export function TextFilter({ value, onChange, close, placeholder = 'Contains…' }: TextFilterProps) {
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        maxLength={120}
        className="h-9 w-full rounded-md border border-slate-300 px-2.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
      />
      <FilterActions onClear={() => { onChange(''); close(); }} />
    </form>
  );
}

export interface NumberRange {
  min: string;
  max: string;
}

export const EMPTY_RANGE: NumberRange = { min: '', max: '' };

export function rangeActive(range: NumberRange): boolean {
  return range.min.trim() !== '' || range.max.trim() !== '';
}

export function inRange(value: number | null | undefined, range: NumberRange): boolean {
  if (!rangeActive(range)) return true;
  if (typeof value !== 'number' || Number.isNaN(value)) return false;
  const min = range.min.trim() === '' ? -Infinity : Number(range.min);
  const max = range.max.trim() === '' ? Infinity : Number(range.max);
  return value >= min && value <= max;
}

interface RangeFilterProps {
  value: NumberRange;
  onChange: (value: NumberRange) => void;
  close: () => void;
  unit?: string;
}

// Rows whose number is between a lowest and a highest value.
export function RangeFilter({ value, onChange, close, unit }: RangeFilterProps) {
  const field = (key: keyof NumberRange, label: string) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-slate-500">
      {label}{unit ? ` (${unit})` : ''}
      <input
        type="number"
        inputMode="decimal"
        value={value[key]}
        onChange={(event) => onChange({ ...value, [key]: event.target.value })}
        className="h-9 w-full rounded-md border border-slate-300 px-2.5 text-sm font-normal text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
      />
    </label>
  );
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="flex gap-2">
        {field('min', 'At least')}
        {field('max', 'At most')}
      </div>
      <FilterActions onClear={() => { onChange(EMPTY_RANGE); close(); }} />
    </form>
  );
}
