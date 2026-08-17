import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import { buildSearchIndex, searchInstructors } from '../lib/instructorSearch';
import type { Instructor } from '../types';

interface InstructorSearchSelectProps {
  instructors: Instructor[];
  selectedId: string;
  onSelect: (instructorId: string) => void;
  disabled?: boolean;
}

/** Rendering all 599 matches would cost more than anyone scrolls through. */
const MAX_RESULTS = 40;

/**
 * Type-to-search selector for the instructor roster.
 *
 * A native select over 599 people is unusable: it cannot be searched beyond
 * first-letter jumping, and it renders every option. This filters on name,
 * email, institute, role and user id, and shows the email under each name so
 * two people with the same name are distinguishable.
 */
export default function InstructorSearchSelect({
  instructors,
  selectedId,
  onSelect,
  disabled,
}: InstructorSearchSelectProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Built once per roster change, not per keystroke.
  const index = useMemo(() => buildSearchIndex(instructors), [instructors]);
  const results = useMemo(
    () => searchInstructors(index, query, MAX_RESULTS),
    [index, query],
  );
  const selected = useMemo(
    () => instructors.find((item) => item._id === selectedId) || null,
    [instructors, selectedId],
  );

  // Close when focus or a click leaves the control.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const choose = (instructor: Instructor) => {
    onSelect(instructor._id);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const clear = () => {
    onSelect('');
    setQuery('');
    setOpen(true);
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIndex((current) => {
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
        if (next < 0) return results.length - 1;
        if (next >= results.length) return 0;
        return next;
      });
      return;
    }
    if (event.key === 'Enter') {
      if (open && results[activeIndex]) {
        event.preventDefault();
        choose(results[activeIndex]);
      }
      return;
    }
    if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      {selected && !open ? (
        // Once chosen, show the person rather than an empty search box, with a
        // clear button to start over.
        <div className="flex items-center gap-3 rounded-md border-2 border-indigo-200 bg-indigo-50/40 p-4">
          <Check size={18} className="shrink-0 text-emerald-600" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-bold text-slate-800">{selected.name}</span>
            <span className="block truncate text-xs text-slate-500">
              {selected.email || 'No email on record'}
            </span>
          </span>
          <button
            type="button"
            onClick={clear}
            disabled={disabled}
            aria-label="Choose a different instructor"
            className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-white hover:text-slate-700 disabled:opacity-50"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <>
          <Search
            size={18}
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls="instructor-search-list"
            aria-autocomplete="list"
            aria-label="Search for an instructor by name or email"
            autoComplete="off"
            disabled={disabled}
            placeholder="Search your name or email…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            className="w-full rounded-md border-2 border-slate-100 bg-slate-50 p-4 pl-11 text-sm font-medium text-slate-700 outline-none transition-all hover:bg-slate-100 focus:border-indigo-500 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 disabled:opacity-60"
          />
        </>
      )}

      {open && !selected && (
        <ul
          ref={listRef}
          id="instructor-search-list"
          role="listbox"
          aria-label="Matching instructors"
          className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-slate-200 bg-white shadow-xl"
        >
          {results.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-slate-400">
              No instructor matches “{query}”.
            </li>
          ) : (
            results.map((instructor, position) => (
              <li
                key={instructor._id}
                role="option"
                aria-selected={position === activeIndex}
                onMouseEnter={() => setActiveIndex(position)}
                onMouseDown={(event) => {
                  // mousedown, not click: the input's blur would close the list
                  // before a click ever landed.
                  event.preventDefault();
                  choose(instructor);
                }}
                className={`cursor-pointer border-b border-slate-100 px-4 py-2.5 last:border-b-0 ${
                  position === activeIndex ? 'bg-indigo-50' : 'hover:bg-slate-50'
                }`}
              >
                <span className="block truncate text-sm font-semibold text-slate-800">
                  {instructor.name}
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {instructor.email || 'No email on record'}
                  {instructor.institute_name ? ` · ${instructor.institute_name}` : ''}
                </span>
              </li>
            ))
          )}
          {results.length === MAX_RESULTS && (
            <li className="border-t border-slate-100 px-4 py-2 text-center text-[11px] text-slate-400">
              Showing the first {MAX_RESULTS} matches — keep typing to narrow.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
