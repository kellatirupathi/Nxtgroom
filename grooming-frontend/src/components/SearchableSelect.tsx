import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  /** Second line, used to tell similar labels apart. */
  hint?: string;
}

interface SearchableSelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Shown in the list when nothing is selected; omit to require a choice. */
  emptyLabel?: string;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
}

/** About six rows, so the list never runs the height of the screen. */
const LIST_MAX_HEIGHT = 'max-h-60';

/**
 * A select with a search box inside it.
 *
 * A native select cannot be filtered beyond first-letter jumping, which is
 * unusable once a list runs to dozens of institutes or hundreds of
 * instructors: the menu covers the screen and the only way to a value is
 * scrolling. This keeps the list short and lets the value be typed.
 */
export default function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  emptyLabel,
  disabled,
  id,
  ariaLabel,
  className = '',
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const base = emptyLabel ? [{ value: '', label: emptyLabel }, ...options] : options;
    if (!term) return base;
    return base.filter((option) => (
      option.label.toLowerCase().includes(term) || (option.hint ?? '').toLowerCase().includes(term)
    ));
  }, [options, query, emptyLabel]);

  const selected = options.find((option) => option.value === value) || null;

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    // Focus the search rather than the list, so typing filters immediately.
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const choose = (option: SelectOption) => {
    onChange(option.value);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => {
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
        if (next < 0) return visible.length - 1;
        if (next >= visible.length) return 0;
        return next;
      });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (visible[activeIndex]) choose(visible[activeIndex]);
      return;
    }
    if (event.key === 'Escape') setOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        id={id}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-white p-3 text-left text-sm outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60"
      >
        <span className={`truncate ${selected ? 'text-slate-700' : 'text-slate-400'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={16} className="shrink-0 text-slate-400" aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute z-40 mt-1 w-full overflow-hidden rounded-md border border-slate-200 bg-white shadow-xl">
          {/* The search sits inside the menu and above the list, so it stays
              in place while the options scroll beneath it. */}
          <div className="border-b border-slate-100 p-2">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleKeyDown}
                placeholder="Search…"
                aria-label="Search options"
                className="w-full rounded border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-2 text-sm outline-none focus:border-indigo-500 focus:bg-white"
              />
            </div>
          </div>

          <ul ref={listRef} role="listbox" className={`${LIST_MAX_HEIGHT} overflow-y-auto`}>
            {visible.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-slate-400">No matches.</li>
            ) : (
              visible.map((option, position) => (
                <li
                  key={option.value || '__empty'}
                  role="option"
                  aria-selected={option.value === value}
                  onMouseEnter={() => setActiveIndex(position)}
                  onMouseDown={(event) => {
                    // mousedown, not click: blur would close the menu first.
                    event.preventDefault();
                    choose(option);
                  }}
                  className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-2 ${
                    position === activeIndex ? 'bg-indigo-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-slate-700">{option.label}</span>
                    {option.hint && (
                      <span className="block truncate text-xs text-slate-400">{option.hint}</span>
                    )}
                  </span>
                  {option.value === value && (
                    <Check size={15} className="shrink-0 text-indigo-600" aria-hidden="true" />
                  )}
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
