import { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { apiFetch, apiJson, invalidateCache } from '../api';
import { useToast } from './useToast';

const SYNC_PATH = '/api/v2/settings/instructor-sync';

interface SyncedInstructor {
  _id: string;
  instructor_user_id?: string | null;
  name?: string | null;
  instructor_role?: string | null;
  institute_name?: string | null;
  instructor_category?: string | null;
}

interface SyncState {
  configured: boolean;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  record_count: number;
  records: SyncedInstructor[];
}

function formatSyncedAt(value: string | null): string {
  if (!value) return 'Never synced';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never synced';
  return `Last synced ${date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Pulls the instructor roster from BigQuery on demand and shows what is
 * currently stored. The sync is manual rather than scheduled because the
 * roster changes rarely and an administrator should decide when the local
 * copy is replaced.
 */
export default function InstructorSyncPanel() {
  const [state, setState] = useState<SyncState | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<SyncState>(SYNC_PATH);
      setState(data);
      setError('');
    } catch (requestError) {
      if ((requestError as { status?: number })?.status !== 401) {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSync = async () => {
    setSyncing(true);
    setError('');
    try {
      const result = await apiJson<{ record_count?: number; upserted?: number; modified?: number }>(
        SYNC_PATH,
        { method: 'POST', timeoutMs: 180_000 },
      );
      // The roster feeds the Instructors page and the check-in dropdown, so
      // their cached copies are now stale.
      invalidateCache('/api/v2/instructors');
      await load();
      toast.success('Sync complete', {
        detail: `${result.record_count ?? 0} instructors — ${result.upserted ?? 0} added, ${result.modified ?? 0} updated.`,
      });
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error('Sync failed', { detail: message });
      void load();
    } finally {
      setSyncing(false);
    }
  };

  const rows = useMemo(() => {
    const all = state?.records ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return all;
    return all.filter((row) => [
      row.name,
      row.instructor_user_id,
      row.instructor_role,
      row.institute_name,
      row.instructor_category,
    ].some((value) => String(value ?? '').toLowerCase().includes(term)));
  }, [state, search]);

  return (
    <section className="flex flex-col h-full" aria-labelledby="sync-title">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div>
          <h3 id="sync-title" className="text-lg font-extrabold text-slate-800 flex items-center gap-2">
            <Database size={20} className="text-indigo-600" aria-hidden="true" />
            Sync Data
          </h3>
          <p className="text-sm text-slate-500 mt-1">
            Import the instructor roster from BigQuery into FacultyTrack.
          </p>
          {/* Stated up front: an administrator should know a sync cannot lose
              anything before they run one against 4,000+ records. */}
          <p className="text-xs text-slate-400 mt-1">
            Adds new instructors and updates changed details. Nothing is ever deleted —
            instructors no longer in BigQuery keep their records and history.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Sits to the left of the button so the state of the data reads
              before the action that changes it. */}
          <span className="text-xs font-medium text-slate-500 text-right">
            {formatSyncedAt(state?.last_sync_at ?? null)}
            {state?.record_count ? (
              <span className="block text-slate-400">{state.record_count.toLocaleString()} instructors</span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing || loading}
            className="bg-indigo-600 text-white px-4 py-2.5 rounded-md font-bold text-sm flex items-center gap-2 hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-200 disabled:opacity-60"
          >
            <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} aria-hidden="true" />
            {syncing ? 'Syncing…' : 'Sync Data'}
          </button>
        </div>
      </div>

      {state && !state.configured && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            BigQuery credentials are not configured on the server. Add
            <code className="mx-1 rounded bg-amber-100 px-1 text-xs">BIGQUERY_CREDENTIALS_JSON</code>
            and redeploy before syncing.
          </span>
        </div>
      )}

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      {state?.last_sync_status === 'failed' && state.last_sync_error && !error && (
        <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
          Last sync failed: {state.last_sync_error}
        </div>
      )}

      <div className="relative mb-3 max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          type="search"
          aria-label="Search synced instructors"
          placeholder="Search instructors…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-full rounded-md border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
        />
      </div>

      <div className="bg-white rounded-md border border-slate-200 overflow-hidden flex-1 flex flex-col min-h-0">
        <div className="overflow-auto">
          <table className="w-full text-left border-collapse min-w-[720px]">
            <thead className="sticky top-0 bg-slate-50 z-10">
              <tr className="border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
                <th className="p-3">Instructor User ID</th>
                <th className="p-3">Instructor Name</th>
                <th className="p-3">Instructor Role</th>
                <th className="p-3">Institute Name</th>
                <th className="p-3">Category</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={5} className="p-8 text-center text-slate-400 font-medium">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-slate-400 font-medium">
                    {state?.record_count
                      ? 'No instructors match your search.'
                      : 'No data yet. Run a sync to import the roster.'}
                  </td>
                </tr>
              ) : rows.map((row) => (
                <tr key={row._id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-3 text-xs font-mono text-slate-500">{row.instructor_user_id || '--'}</td>
                  <td className="p-3 text-sm font-bold text-slate-800">{row.name || '--'}</td>
                  <td className="p-3 text-sm text-slate-600">{row.instructor_role || '--'}</td>
                  <td className="p-3 text-sm text-slate-600">{row.institute_name || '--'}</td>
                  <td className="p-3 text-sm text-slate-600">{row.instructor_category || '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {rows.length > 0 && (
        <p className="mt-2 text-xs text-slate-400">
          Showing {rows.length.toLocaleString()} of {(state?.record_count ?? 0).toLocaleString()} instructors.
        </p>
      )}
    </section>
  );
}
