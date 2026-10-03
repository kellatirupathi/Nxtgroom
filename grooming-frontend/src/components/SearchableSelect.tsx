import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

interface SearchableSelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
}

const LIST_MAX_HEIGHT = 'max-h-60';
const ESTIMATED_MENU_HEIGHT = 300;

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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);

  const positionMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flip = spaceBelow < ESTIMATED_MENU_HEIGHT && rect.top > spaceBelow;
    setPosition({
      top: flip ? Math.max(8, rect.top - ESTIMATED_MENU_HEIGHT - 4) : rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    });
  }, []);

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
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    positionMenu();
    window.addEventListener('scroll', positionMenu, true);
    window.addEventListener('resize', positionMenu);
    return () => {
      window.removeEventListener('scroll', positionMenu, true);
      window.removeEventListener('resize', positionMenu);
    };
  }, [open, positionMenu]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
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
        ref={triggerRef}
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

      {open && position && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: position.top, left: position.left, width: position.width }}
          className="z-[200] overflow-hidden rounded-md border border-slate-200 bg-white shadow-2xl">
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
        </div>,
        document.body,
      )}
    </div>
  );
}
