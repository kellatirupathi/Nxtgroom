import { useCallback, useEffect, useRef, useState } from 'react';
import { Building2, Edit2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { apiFetch, apiFetchCached, apiJson, invalidateCache, readStale } from '../api';
import ConfirmDialog from './ConfirmDialog';
import InstituteFormDialog from './InstituteFormDialog';
import { useToast } from './useToast';
import { useLocation } from '../lib/useLocation';
import { closeChildPath, dialogPath, dialogRouteFromPath, goToPath, openChildPath } from '../routes';
import type { College } from '../types';

const COLLEGES_PATH = '/api/v2/colleges';
const LIST_PATH = '/settings/institutes';

export default function CollegeManagement() {
  const cachedColleges = readStale<College[]>(COLLEGES_PATH);
  const [colleges, setColleges] = useState<College[]>(
    Array.isArray(cachedColleges) ? cachedColleges : [],
  );
  const [loading, setLoading] = useState(!Array.isArray(cachedColleges));
  const [fetched, setFetched] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<College | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<College | null>(null);
  const [syncing, setSyncing] = useState(false);
  const hasRowsRef = useRef(colleges.length > 0);
  const toast = useToast();
  const { pathname } = useLocation();

  const fetchColleges = useCallback(async () => {
    if (!hasRowsRef.current) setLoading(true);
    try {
      const data = await apiFetchCached<College[]>(COLLEGES_PATH);
      const rows = Array.isArray(data) ? data : [];
      hasRowsRef.current = rows.length > 0;
      setColleges(rows);
      setError('');
    } catch (requestError) {
      if ((requestError as { status?: number })?.status !== 401) setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
      setFetched(true);
    }
  }, []);

  useEffect(() => {
    fetchColleges();
  }, [fetchColleges]);

  const prepareCreateModal = () => {
    setEditing(null);
    setError('');
    setShowModal(true);
  };

  const prepareEditModal = (college: College) => {
    setEditing(college);
    setError('');
    setShowModal(true);
  };

  const openCreateModal = () => {
    prepareCreateModal();
    openChildPath(dialogPath(LIST_PATH, { view: 'new' }));
  };

  const openEditModal = (college: College) => {
    prepareEditModal(college);
    openChildPath(dialogPath(LIST_PATH, { view: 'edit', id: String(college._id) }));
  };

  const closeModal = () => {
    setShowModal(false);
    closeChildPath(LIST_PATH);
  };

  const latest = useRef({ showModal, editing, colleges });
  useEffect(() => {
    latest.current = { showModal, editing, colleges };
  });

  useEffect(() => {
    const current = latest.current;
    const route = dialogRouteFromPath(pathname, LIST_PATH);
    if (route.view === 'new') {
      if (!current.showModal || current.editing) prepareCreateModal();
      return;
    }
    if (route.view === 'edit') {
      if (current.showModal && String(current.editing?._id) === route.id) return;
      const target = current.colleges.find((college) => String(college._id) === route.id);
      if (target) {
        prepareEditModal(target);
      } else if (fetched) {
        setShowModal(false);
        goToPath(LIST_PATH, { replace: true });
      }
      return;
    }
    if (current.showModal) setShowModal(false);
  }, [pathname, fetched]);

  const handleSaved = (saved: College, wasEdit: boolean) => {
    if (wasEdit) {
      setColleges((current) => current.map((college) => (
        String(college._id) === String(saved._id) ? { ...college, ...saved } : college
      )));
    } else if (saved._id) {
      setColleges((current) => [...current, saved]);
    }
    closeModal();
    setEditing(null);
  };

  const handleDelete = async (college: College) => {
    setDeletingId(String(college._id));
    setError('');
    try {
      await apiFetch(`${COLLEGES_PATH}/${encodeURIComponent(college._id)}`, { method: 'DELETE' });
      invalidateCache(COLLEGES_PATH);
      setColleges((current) => current.filter((item) => String(item._id) !== String(college._id)));
      toast.success('Institute deleted', { detail: college.name });
      setConfirmTarget(null);
    } catch (requestError) {
      if ((requestError as { status?: number })?.status !== 401) {
        const message = requestError instanceof Error ? requestError.message : String(requestError);
        setError(message);
        toast.error('Could not delete institute', { detail: message });
      }
      setConfirmTarget(null);
    } finally {
      setDeletingId(null);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setError('');
    try {
      const result = await apiJson<{ record_count?: number; upserted?: number; instructors_linked?: number }>(
        '/api/v2/settings/institute-sync',
        { method: 'POST', timeoutMs: 120_000 },
      );
      invalidateCache(COLLEGES_PATH);
      invalidateCache('/api/v2/instructors');
      await fetchColleges();
      toast.success('Institutes synced', {
        detail: `${result.record_count ?? 0} institutes · ${result.instructors_linked ?? 0} instructors assigned.`,
      });
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error('Could not sync institutes', { detail: message });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section className="w-full flex flex-col h-full animate-in fade-in duration-300" aria-labelledby="college-title">
      <div className="flex justify-between items-center mb-6 shrink-0 gap-4 flex-wrap">
        <div>
          <h2 id="college-title" className="text-xl font-extrabold text-slate-800 flex items-center gap-2"><Building2 size={24} className="text-indigo-600" aria-hidden="true" />Institute Management</h2>
          <p className="text-sm text-slate-500 mt-1">Manage partner institutes and campuses.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing || loading}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
          >
            <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} aria-hidden="true" />
            {syncing ? 'Syncing…' : 'Sync Data'}
          </button>
          <button type="button" onClick={openCreateModal} className="bg-indigo-600 text-white px-4 py-2.5 rounded-md font-bold text-sm flex items-center gap-2 hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-200"><Plus size={18} aria-hidden="true" />Add New Institute</button>
        </div>
      </div>

      {error && <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}

      <div className="bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden flex-1 flex flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-0 md:min-w-[700px]">
            <thead><tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider"><th className="p-4 hidden lg:table-cell">Institute ID</th><th className="p-4">Name</th><th className="p-4 hidden sm:table-cell">Location</th><th className="p-4 text-right">Actions</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={4} className="p-8 text-center text-slate-400 font-medium">Loading institutes…</td></tr>
              ) : colleges.length === 0 ? (
                <tr><td colSpan={4} className="p-8 text-center text-slate-400 font-medium">No institutes found. Sync from BigQuery or add one to get started.</td></tr>
              ) : colleges.map((college) => (
                <tr key={college._id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-4 text-xs font-mono text-slate-400 hidden lg:table-cell">{college._id}</td>
                  <td className="p-4 font-bold text-slate-800">
                    {college.name}
                    {college.location && <span className="mt-0.5 block text-xs font-medium text-slate-500 sm:hidden">{college.location}</span>}
                  </td>
                  <td className="p-4 text-sm font-medium text-slate-600 hidden sm:table-cell">{college.location}</td>
                  <td className="p-4">
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" aria-label={`Edit ${college.name}`} title={`Edit ${college.name}`} disabled={Boolean(deletingId)} onClick={() => openEditModal(college)} className="rounded-md border border-indigo-100 bg-indigo-50 p-2 text-indigo-700 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"><Edit2 size={16} aria-hidden="true" /></button>
                      <button type="button" aria-label={`Delete ${college.name}`} title={`Delete ${college.name}`} disabled={Boolean(deletingId)} onClick={() => setConfirmTarget(college)} className="rounded-md border border-rose-100 bg-rose-50 p-2 text-rose-700 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500 disabled:opacity-50"><Trash2 size={16} aria-hidden="true" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <InstituteFormDialog
        open={showModal}
        college={editing}
        onClose={closeModal}
        onSaved={handleSaved}
      />

      <ConfirmDialog
        open={Boolean(confirmTarget)}
        destructive
        busy={Boolean(deletingId)}
        title="Delete institute"
        message={`Delete ${confirmTarget?.name ?? 'this institute'}? This cannot be undone.`}
        detail="Reassign active BOAs and instructors to another institute first, or the delete will be refused."
        confirmLabel="Delete"
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => confirmTarget && handleDelete(confirmTarget)}
      />
    </section>
  );
}
