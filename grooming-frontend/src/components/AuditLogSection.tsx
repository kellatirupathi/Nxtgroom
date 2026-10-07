import { useEffect, useState } from 'react';
import { History, Search } from 'lucide-react';
import { apiFetch } from '../api';

const PATH = '/api/v2/settings/audit-log';
const PAGE_SIZE = 50;
const FIELD = 'h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

const CATEGORIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All activity' },
  { value: 'login', label: 'Logins' },
  { value: 'create', label: 'Created' },
  { value: 'edit', label: 'Edited' },
  { value: 'delete', label: 'Deleted' },
  { value: 'settings', label: 'Settings changes' },
];

const CATEGORY_STYLE: Record<string, string> = {
  login: 'bg-sky-50 text-sky-700 border-sky-200',
  create: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  edit: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  delete: 'bg-rose-50 text-rose-700 border-rose-200',
  settings: 'bg-amber-50 text-amber-700 border-amber-200',
};

interface AuditEntry {
  id: string;
  at: string;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  category: string;
  target: string | null;
  fields?: string[];
  status: number;
  ip?: string;
}

function when(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '--'
    : date.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

export default function AuditLogSection() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(0); }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    if (query) params.set('q', query);
    if (category) params.set('category', category);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    apiFetch<{ total: number; entries: AuditEntry[] }>(`${PATH}?${params.toString()}`)
      .then((data) => {
        if (disposed) return;
        setEntries(Array.isArray(data?.entries) ? data.entries : []);
        setTotal(Number(data?.total) || 0);
        setError('');
      })
      .catch((requestError) => {
        if (!disposed && (requestError as { status?: number })?.status !== 401) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [query, category, from, to, page]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const resetPage = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setPage(0); };

  return (
    <section aria-labelledby="audit-title">
      <h3 id="audit-title" className="flex items-center gap-2 text-base font-bold text-slate-800">
        <History size={18} className="text-indigo-600" aria-hidden="true" />
        Audit log
      </h3>
      <p className="mt-1 mb-4 text-sm text-slate-500">
        Who signed in, and who created, edited or deleted something or changed a setting, and when. Kept permanently.
        Passwords and other secrets are never recorded. Check-ins and check-outs are not listed here.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="relative min-w-0 flex-1 basis-full sm:basis-auto sm:flex-none">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search person, action or item" aria-label="Search the audit log" className={`${FIELD} w-full pl-9 sm:w-72`} />
        </span>
        <select value={category} onChange={(event) => resetPage(setCategory)(event.target.value)} aria-label="Activity type" className={FIELD}>
          {CATEGORIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <input type="date" value={from} max={to || undefined} onChange={(event) => resetPage(setFrom)(event.target.value)} aria-label="From date" className={FIELD} />
        <span className="text-xs font-semibold text-slate-500">to</span>
        <input type="date" value={to} min={from || undefined} onChange={(event) => resetPage(setTo)(event.target.value)} aria-label="To date" className={FIELD} />
      </div>

      {error && <p role="alert" className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</p>}

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-3">When</th>
              <th scope="col" className="px-3 py-3">Who</th>
              <th scope="col" className="px-3 py-3">Activity</th>
              <th scope="col" className="px-3 py-3">Item</th>
              <th scope="col" className="px-3 py-3">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 align-top">
            {loading && !entries.length ? (
              <tr><td colSpan={5} className="p-8 text-center text-slate-400">Loading the audit log…</td></tr>
            ) : !entries.length ? (
              <tr><td colSpan={5} className="p-8 text-center text-slate-400">No activity matches these filters.</td></tr>
            ) : entries.map((entry) => (
              <tr key={entry.id}>
                <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{when(entry.at)}</td>
                <td className="px-3 py-2.5">
                  <span className="block font-semibold text-slate-800">{entry.actor_email || '--'}</span>
                  {entry.actor_role && <span className="block text-xs text-slate-500">{entry.actor_role.replace('_', ' ')}</span>}
                </td>
                <td className="px-3 py-2.5">
                  <span className={`mr-2 inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold ${CATEGORY_STYLE[entry.category] || 'bg-slate-50 text-slate-600 border-slate-200'}`}>
                    {CATEGORIES.find((option) => option.value === entry.category)?.label || entry.category}
                  </span>
                  <span className="text-slate-800">{entry.action}</span>
                  {entry.fields && entry.fields.length > 0 && (
                    <span className="mt-0.5 block text-xs text-slate-500">Fields: {entry.fields.join(', ')}</span>
                  )}
                </td>
                <td className="max-w-[14rem] break-all px-3 py-2.5 text-xs text-slate-600">{entry.target || '--'}</td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <span className={`text-xs font-bold ${entry.status < 400 ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {entry.status < 400 ? 'Done' : `Failed (${entry.status})`}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
        <span>{total.toLocaleString('en-IN')} {total === 1 ? 'entry' : 'entries'}</span>
        <span className="flex items-center gap-2">
          <button type="button" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page === 0 || loading} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 font-semibold disabled:opacity-40">Previous</button>
          <span>Page {page + 1} of {pages}</span>
          <button type="button" onClick={() => setPage((current) => Math.min(pages - 1, current + 1))} disabled={page + 1 >= pages || loading} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 font-semibold disabled:opacity-40">Next</button>
        </span>
      </div>
    </section>
  );
}
