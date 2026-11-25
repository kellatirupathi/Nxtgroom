import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ClipboardList, Download, ExternalLink, FileUp, Loader2, Search, SlidersHorizontal, Users, X } from 'lucide-react';
import PeopleTable from './PeopleTable';
import { apiFetch } from '../api';
import { goToPath, pathForTab, TABS } from '../routes';
import { saveCsvFile } from '../attendanceExport';
import {
  isCompleteRange,
  localDateValue,
  rangeForPreset,
  type DatePreset,
  type DateRange,
} from '../attendanceFilters';
import ColumnHeader, { OptionsFilter, TextFilter } from './ColumnHeader';
import DateRangeFilter from './DateRangeFilter';
import FormResponsesImportDialog from './FormResponsesImportDialog';
import ImageLightbox, { type LightboxImage } from './ImageLightbox';
import { sortRows, textMatches, timeValue, uniqueValues, type ColumnSort } from '../lib/tableSort';
import {
  displayDate,
  FORM_REASON_OPTIONS,
  FORM_SOURCE_OPTIONS,
  FORM_STATUS_OPTIONS,
  formatMoment,
  formResponsesCsv,
  formResponsesFileName,
  peopleCount,
  peopleProgress,
  sourceLabel,
  statusLabel,
  type FormReason,
  type FormResponse,
  type FormSource,
  type FormStatus,
} from '../lib/instituteForm';

type PhotosFilter = '' | 'with' | 'without';

const PEOPLE_REFRESH_MS = 15_000;

interface Filters {
  date: string;
  institute: string;
  status: FormStatus | '';
  photos: PhotosFilter;
  submittedBy: string;
  reason: FormReason | '';
  source: FormSource | '';
}

const NO_FILTERS: Filters = { date: '', institute: '', status: '', photos: '', submittedBy: '', reason: '', source: '' };

const PHOTO_OPTIONS: ReadonlyArray<{ value: Exclude<PhotosFilter, ''>; label: string }> = [
  { value: 'with', label: 'With pictures' },
  { value: 'without', label: 'No pictures' },
];

const FIELD = 'h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

function pictureCount(row: FormResponse): number {
  return row.photos.length + row.photo_links.length;
}

function matchesFilters(row: FormResponse, filters: Filters, search: string): boolean {
  if (filters.date && row.form_date !== filters.date) return false;
  if (filters.institute && row.college_name !== filters.institute) return false;
  if (filters.status && row.status !== filters.status) return false;
  if (filters.photos === 'with' && pictureCount(row) === 0) return false;
  if (filters.photos === 'without' && pictureCount(row) > 0) return false;
  if (!textMatches(row.submitted_by, filters.submittedBy)) return false;
  if (filters.reason && row.reason !== filters.reason) return false;
  if (filters.source && row.source !== filters.source) return false;
  const term = search.trim();
  if (!term) return true;
  return [row.college_name, row.submitted_by, row.reason_label, displayDate(row.form_date), statusLabel(row.status), sourceLabel(row.source)]
    .some((value) => textMatches(value, term));
}

function sortValue(row: FormResponse, key: string): string | number | null {
  switch (key) {
    case 'form_date': return row.form_date;
    case 'institute': return row.college_name;
    case 'status': return statusLabel(row.status);
    case 'photos': return pictureCount(row);
    case 'people': {
      const count = peopleCount(row.photos);
      return count.identified + count.unknown ? count.identified : null;
    }
    case 'submitted_by': return row.submitted_by;
    case 'reason': return row.reason_label;
    case 'source': return sourceLabel(row.source);
    case 'submitted_at': return timeValue(row.submitted_at);
    default: return null;
  }
}

function StatusTag({ status }: { status: string }) {
  const yes = status === 'yes';
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-bold ${yes ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
      {statusLabel(status)}
    </span>
  );
}

function SourceTag({ source }: { source: string }) {
  const manual = source === 'manual';
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-bold ${manual ? 'border-violet-200 bg-violet-50 text-violet-700' : 'border-sky-200 bg-sky-50 text-sky-700'}`}>
      {sourceLabel(source)}
    </span>
  );
}

// Whether the People column has anything to say for a response.
function hasPeopleInfo(row: FormResponse): boolean {
  const count = peopleCount(row.photos);
  const progress = peopleProgress(row.photos);
  return count.identified + count.unknown + progress.pending + progress.failed > 0;
}

// The People column: how many were identified in the photos, opening the
// Name | ID | Image table. People are found on the server after the form is
// sent, so a new response shows "Finding people…" for a moment first.
function PeopleCell({ row, onOpen }: { row: FormResponse; onOpen: () => void }) {
  const count = peopleCount(row.photos);
  const progress = peopleProgress(row.photos);
  if (!count.identified && !count.unknown) {
    if (progress.pending) {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500" role="status">
          <Loader2 size={13} className="animate-spin text-indigo-600" aria-hidden="true" />
          Finding people…
        </span>
      );
    }
    if (progress.failed) return <span className="text-xs text-amber-700">People could not be read</span>;
    return <span className="text-slate-400">—</span>;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    >
      <Users size={13} aria-hidden="true" />
      {count.identified} named
      {count.unknown > 0 && <span className="font-medium text-slate-500">· {count.unknown} not named</span>}
      {progress.pending > 0 && <Loader2 size={12} className="animate-spin text-indigo-600" aria-label="Still finding people in some photos" />}
    </button>
  );
}

function Pictures({ row, onOpen }: { row: FormResponse; onOpen: (images: LightboxImage[], index: number) => void }) {
  if (!row.photos.length && !row.photo_links.length) return <span className="text-slate-400">—</span>;
  const images = row.photos.map((photo, index) => ({ url: photo.url, label: `Photo ${index + 1}` }));
  const shown = row.photos.slice(0, 3);
  return (
    <span className="inline-flex items-center gap-1.5">
      {shown.map((photo, index) => (
        <button
          key={photo.id}
          type="button"
          onClick={() => onOpen(images, index)}
          aria-label={`View photo ${index + 1} from ${row.college_name}`}
          className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {(photo.thumb_url || photo.url) && <img src={photo.thumb_url || photo.url || ''} alt="" loading="lazy" className="h-full w-full object-cover" />}
        </button>
      ))}
      {row.photos.length > 3 && (
        <button type="button" onClick={() => onOpen(images, 3)} className="rounded-md bg-slate-100 px-1.5 py-1 text-xs font-bold text-slate-600 hover:bg-slate-200">
          +{row.photos.length - 3}
        </button>
      )}
      {row.photo_links.map((link, index) => (
        <a
          key={link}
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          title={link}
          className="inline-flex items-center gap-0.5 rounded-md border border-slate-200 px-1.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
        >
          Link {index + 1}
          <ExternalLink size={11} aria-hidden="true" />
        </a>
      ))}
    </span>
  );
}

export default function FormResponsesSection() {
  const [today] = useState(() => localDateValue());
  const [preset, setPreset] = useState<DatePreset>('last_week');
  const [range, setRange] = useState<DateRange>(() => rangeForPreset('last_week', localDateValue()));
  const [rows, setRows] = useState<FormResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<ColumnSort | null>({ key: 'form_date', direction: 'desc' });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [viewer, setViewer] = useState<{ images: LightboxImage[]; index: number; title: string } | null>(null);
  const [peopleOf, setPeopleOf] = useState<FormResponse | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const query = useMemo(() => {
    if (preset === 'all_time') return '';
    const params = new URLSearchParams();
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    const text = params.toString();
    return text ? `?${text}` : '';
  }, [preset, range]);

  useEffect(() => {
    if (!isCompleteRange(range, preset)) return undefined;
    const controller = new AbortController();
    setLoading(true);
    apiFetch<FormResponse[]>(`/api/v2/form-responses${query}`, { signal: controller.signal })
      .then((data) => {
        setRows(Array.isArray(data) ? data : []);
        setError('');
      })
      .catch((requestError) => {
        if (controller.signal.aborted || (requestError as { status?: number })?.status === 401) return;
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query, range, preset, reloadKey]);

  // While the people in some photos are still being found, look again
  // quietly every little while until they are all read.
  const findingPeople = rows.some((row) => peopleProgress(row.photos).pending > 0);
  useEffect(() => {
    if (!findingPeople || !isCompleteRange(range, preset)) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      apiFetch<FormResponse[]>(`/api/v2/form-responses${query}`, { signal: controller.signal })
        .then((data) => { if (Array.isArray(data)) setRows(data); })
        .catch(() => { });
    }, PEOPLE_REFRESH_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [findingPeople, rows, query, range, preset]);

  // Keep an open People table in step with reloaded rows.
  useEffect(() => {
    setPeopleOf((current) => (current ? rows.find((row) => row._id === current._id) ?? current : current));
  }, [rows]);

  useEffect(() => {
    if (!filtersOpen) return undefined;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFiltersOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [filtersOpen]);

  const filtered = useMemo(
    () => sortRows(rows.filter((row) => matchesFilters(row, filters, search)), sort, sortValue),
    [rows, filters, search, sort],
  );

  const instituteOptions = useMemo(() => uniqueValues(rows.map((row) => row.college_name)).map((value) => ({ value, label: value })), [rows]);
  const dateOptions = useMemo(
    () => [...new Set(rows.map((row) => row.form_date))].sort().reverse().map((value) => ({ value, label: displayDate(value) })),
    [rows],
  );
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((current) => ({ ...current, [key]: value }));
  const clearAll = () => {
    setFilters(NO_FILTERS);
    setSearch('');
  };
  const onSort = (key: string) => setSort((current) => (
    current?.key === key ? (current.direction === 'asc' ? { key, direction: 'desc' } : null) : { key, direction: 'asc' }
  ));
  const openViewer = (row: FormResponse) => (images: LightboxImage[], index: number) => (
    setViewer({ images, index, title: `${row.college_name} · ${displayDate(row.form_date)}` })
  );

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    setExportError('');
    try {
      // Fresh links that stay valid for 7 days, for the rows on screen.
      const separator = query ? '&' : '?';
      const fresh = await apiFetch<FormResponse[]>(`/api/v2/form-responses${query}${separator}export=1`);
      const ids = new Set(filtered.map((row) => row._id));
      const byId = new Map(fresh.map((row) => [row._id, row]));
      const ordered = filtered.map((row) => byId.get(row._id) ?? row).filter((row) => ids.has(row._id));
      await saveCsvFile(formResponsesFileName(preset === 'all_time' ? '' : range.from, preset === 'all_time' ? '' : range.to), formResponsesCsv(ordered));
    } catch (requestError) {
      setExportError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setExporting(false);
    }
  };

  const columns: ReadonlyArray<{ key: string; label: string; filter?: { active: boolean; render: (close: () => void) => ReactNode } }> = [
    {
      key: 'form_date',
      label: 'Date',
      filter: {
        active: Boolean(filters.date),
        render: (close) => <OptionsFilter value={filters.date} options={dateOptions} onChange={(value) => setFilter('date', value)} close={close} allLabel="All dates" />,
      },
    },
    {
      key: 'institute',
      label: 'University Name',
      filter: {
        active: Boolean(filters.institute),
        render: (close) => <OptionsFilter value={filters.institute} options={instituteOptions} onChange={(value) => setFilter('institute', value)} close={close} allLabel="All institutes" />,
      },
    },
    {
      key: 'status',
      label: 'Photo Submission Status',
      filter: {
        active: Boolean(filters.status),
        render: (close) => <OptionsFilter value={filters.status} options={FORM_STATUS_OPTIONS} onChange={(value) => setFilter('status', value)} close={close} />,
      },
    },
    {
      key: 'photos',
      label: 'Appearance Picture',
      filter: {
        active: Boolean(filters.photos),
        render: (close) => <OptionsFilter value={filters.photos} options={PHOTO_OPTIONS} onChange={(value) => setFilter('photos', value)} close={close} />,
      },
    },
    { key: 'people', label: 'People' },
    {
      key: 'submitted_by',
      label: 'Submitted By',
      filter: {
        active: Boolean(filters.submittedBy.trim()),
        render: (close) => <TextFilter value={filters.submittedBy} onChange={(value) => setFilter('submittedBy', value)} close={close} placeholder="Name contains…" />,
      },
    },
    {
      key: 'reason',
      label: 'Reason for Non Submission',
      filter: {
        active: Boolean(filters.reason),
        render: (close) => <OptionsFilter value={filters.reason} options={FORM_REASON_OPTIONS} onChange={(value) => setFilter('reason', value)} close={close} />,
      },
    },
    {
      key: 'source',
      label: 'Type',
      filter: {
        active: Boolean(filters.source),
        render: (close) => <OptionsFilter value={filters.source} options={FORM_SOURCE_OPTIONS} onChange={(value) => setFilter('source', value)} close={close} />,
      },
    },
    { key: 'submitted_at', label: 'Submitted At' },
  ];

  return (
    <section className="flex h-full min-h-0 w-full flex-col" aria-labelledby="form-responses-title">
      <div className="mb-4 flex shrink-0 items-start gap-1">
        <button
          type="button"
          onClick={() => goToPath(pathForTab(TABS.MORE))}
          aria-label="Back to More"
          className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-900 hover:bg-slate-100 lg:hidden"
        >
          <ChevronLeft size={22} aria-hidden="true" />
        </button>
        <div className="min-w-0 pt-2 lg:pt-0">
          <h2 id="form-responses-title" className="flex items-center gap-2 text-xl font-extrabold text-slate-900 lg:font-bold lg:text-slate-800">
            <ClipboardList size={22} className="hidden text-indigo-600 lg:block" aria-hidden="true" />
            Form Responses
          </h2>
        </div>
      </div>

      <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="relative flex min-w-0 flex-1 items-center gap-2">
          <span className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 sm:left-2.5" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search form responses"
              maxLength={120}
              placeholder="Search institute, name, reason…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-11 w-full rounded-lg border border-slate-300 bg-white py-0 pl-9 pr-3 text-base font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 sm:h-9 sm:rounded-md sm:pl-8 sm:text-sm"
            />
          </span>
          <div className="shrink-0 md:relative">
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={filtersOpen}
              aria-label={activeFilterCount ? `Filters, ${activeFilterCount} active` : 'Filters'}
              className={`relative flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500/20 sm:h-9 sm:justify-start sm:rounded-md ${
                activeFilterCount
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <SlidersHorizontal size={18} className="sm:size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Filters</span>
              {activeFilterCount > 0 && (
                <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-600 px-1.5 text-[11px] font-bold text-white sm:static">
                  {activeFilterCount}
                </span>
              )}
            </button>
            {filtersOpen && (
              <>
                <button
                  type="button"
                  aria-label="Close filters"
                  tabIndex={-1}
                  onClick={() => setFiltersOpen(false)}
                  className="fixed inset-0 z-[60] h-full w-full cursor-default bg-slate-900/20 sm:bg-transparent"
                />
                <div
                  role="dialog"
                  aria-modal="false"
                  aria-labelledby="form-responses-filters-title"
                  className="absolute left-0 top-full z-[61] mt-2 flex w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl"
                >
                  <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                    <h4 id="form-responses-filters-title" className="flex items-center gap-2 text-base font-bold text-slate-800">
                      <SlidersHorizontal size={18} className="text-indigo-600" aria-hidden="true" />
                      Filters
                    </h4>
                    <button
                      ref={closeRef}
                      type="button"
                      onClick={() => setFiltersOpen(false)}
                      aria-label="Close filters"
                      className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <X size={18} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="max-h-[min(30rem,calc(100dvh-16rem))] space-y-4 overflow-y-auto px-4 py-4">
                    <div>
                      <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-slate-500">Date</p>
                      <DateRangeFilter
                        preset={preset}
                        range={range}
                        today={today}
                        onChange={(nextPreset, nextRange) => {
                          setPreset(nextPreset);
                          setRange(nextRange);
                          setFilter('date', '');
                        }}
                      />
                    </div>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Institute</span>
                      <select value={filters.institute} onChange={(event) => setFilter('institute', event.target.value)} className={FIELD}>
                        <option value="">All institutes</option>
                        {instituteOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Photo Submission Status</span>
                      <select value={filters.status} onChange={(event) => setFilter('status', event.target.value as FormStatus | '')} className={FIELD}>
                        <option value="">Yes and No</option>
                        {FORM_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Reason for Non Submission</span>
                      <select value={filters.reason} onChange={(event) => setFilter('reason', event.target.value as FormReason | '')} className={FIELD}>
                        <option value="">All reasons</option>
                        {FORM_REASON_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Type</span>
                      <select value={filters.source} onChange={(event) => setFilter('source', event.target.value as FormSource | '')} className={FIELD}>
                        <option value="">Automatic and Manual</option>
                        {FORM_SOURCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="flex items-center gap-3 border-t border-slate-200 px-4 py-3">
                    <button type="button" onClick={clearAll} className="h-10 flex-1 rounded-md border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50">
                      Clear all
                    </button>
                    <button type="button" onClick={() => setFiltersOpen(false)} className="h-10 flex-1 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700">
                      Show {filtered.length} {filtered.length === 1 ? 'response' : 'responses'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          {(activeFilterCount > 0 || search) && (
            <button
              type="button"
              onClick={clearAll}
              aria-label="Clear filters"
              title="Clear all filters and the search"
              className="flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-700 transition-colors hover:bg-rose-50 sm:h-9 sm:justify-start sm:rounded-md"
            >
              <X size={18} className="sm:size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Clear</span>
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => { void exportCsv(); }}
            disabled={exporting || filtered.length === 0}
            aria-label="Export form responses"
            className="flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:h-9 sm:rounded-md"
          >
            <Download size={18} className="sm:size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{exporting ? 'Exporting…' : 'Export'}</span>
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            aria-label="Import form responses"
            className="flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 sm:h-9 sm:rounded-md"
          >
            <FileUp size={18} className="sm:size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Import</span>
          </button>
        </div>
      </div>

      {(error || exportError) && (
        <p role="alert" className="mb-3 shrink-0 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error || exportError}</p>
      )}

      <ul className="flex flex-col gap-2.5 pb-2 md:hidden" aria-label="Form responses">
        {loading && !rows.length && <li className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">Loading responses…</li>}
        {!loading && filtered.length === 0 && (
          <li className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">{rows.length ? 'No responses match these filters.' : 'No responses in this period.'}</li>
        )}
        {filtered.map((row) => (
          <li key={row._id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-900">{row.college_name}</p>
                <p className="text-xs text-slate-500">{displayDate(row.form_date)} · {row.submitted_by}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <StatusTag status={row.status} />
                <SourceTag source={row.source} />
              </div>
            </div>
            <div className="mt-2.5 text-xs text-slate-600">
              {row.status === 'yes' ? <Pictures row={row} onOpen={openViewer(row)} /> : <span>{row.reason_label || '—'}</span>}
            </div>
            {row.status === 'yes' && hasPeopleInfo(row) && (
              <div className="mt-2">
                <PeopleCell row={row} onOpen={() => setPeopleOf(row)} />
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="hidden min-h-[16rem] flex-1 overflow-auto overscroll-contain rounded-lg border border-slate-200 bg-white shadow-sm md:block" tabIndex={0} aria-label="Form responses, scrollable">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead>
            <tr className="h-10">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={sort?.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className="sticky top-0 z-10 bg-slate-50 px-3 text-xs font-bold uppercase tracking-wider text-slate-500 shadow-[inset_0_-1px_0_0_rgb(226_232_240)] first:pl-4 last:pr-4"
                >
                  <ColumnHeader
                    label={column.label}
                    sortKey={column.key}
                    sort={sort}
                    onSort={onSort}
                    filterActive={column.filter?.active}
                    filter={column.filter?.render}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && !rows.length && (
              <tr><td colSpan={columns.length} className="p-8 text-center text-sm text-slate-400">Loading responses…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={columns.length} className="p-8 text-center text-sm text-slate-400">{rows.length ? 'No responses match these filters.' : 'No responses in this period.'}</td></tr>
            )}
            {filtered.map((row, index) => {
              const cell = `px-3 py-2.5 first:pl-4 last:pr-4 align-middle ${index === 0 ? '' : 'shadow-[inset_0_1px_0_0_rgb(241_245_249)]'}`;
              return (
                <tr key={row._id} className="hover:bg-slate-50">
                  <td className={`${cell} whitespace-nowrap font-semibold text-slate-800`}>{displayDate(row.form_date)}</td>
                  <td className={`${cell} max-w-[220px] truncate text-slate-800`} title={row.college_name}>{row.college_name}</td>
                  <td className={cell}><StatusTag status={row.status} /></td>
                  <td className={cell}><Pictures row={row} onOpen={openViewer(row)} /></td>
                  <td className={cell}><PeopleCell row={row} onOpen={() => setPeopleOf(row)} /></td>
                  <td className={`${cell} max-w-[180px] truncate text-slate-700`} title={row.submitted_by}>{row.submitted_by}</td>
                  <td className={`${cell} max-w-[220px] truncate text-slate-700`} title={row.reason_label}>{row.reason_label || <span className="text-slate-400">—</span>}</td>
                  <td className={cell}><SourceTag source={row.source} /></td>
                  <td className={`${cell} whitespace-nowrap text-xs text-slate-500`}>
                    {formatMoment(row.submitted_at)}
                    {row.edit_count > 0 && <span className="block text-[11px] text-slate-400">edited {formatMoment(row.updated_at)}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 shrink-0 text-xs text-slate-500">
        Showing {filtered.length} of {rows.length} response{rows.length === 1 ? '' : 's'}
      </p>

      <FormResponsesImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={() => setReloadKey((key) => key + 1)} />

      {viewer && <ImageLightbox images={viewer.images} startIndex={viewer.index} title={viewer.title} onClose={() => setViewer(null)} />}

      {peopleOf && (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="people-dialog-title"
          onClick={() => setPeopleOf(null)}
          onKeyDown={(event) => { if (event.key === 'Escape') setPeopleOf(null); }}
        >
          <div className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-xl bg-white shadow-xl sm:rounded-lg" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <h2 id="people-dialog-title" className="flex items-center gap-2 text-base font-bold text-slate-800">
                  <Users size={18} className="text-indigo-600" aria-hidden="true" />
                  People in the photos
                </h2>
                <p className="mt-0.5 truncate text-sm text-slate-500">{peopleOf.college_name} · {displayDate(peopleOf.form_date)}</p>
              </div>
              <button type="button" onClick={() => setPeopleOf(null)} aria-label="Close" autoFocus className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100">
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <PeopleTable photos={peopleOf.photos} title={`${peopleOf.college_name} · ${displayDate(peopleOf.form_date)}`} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
