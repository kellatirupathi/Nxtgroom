import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Building2, Edit2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { apiFetch, apiFetchCached, apiJson, invalidateCache, readStale } from '../api';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './useToast';
import type { College } from '../types';

const COLLEGES_PATH = '/api/v2/colleges';

const EMPTY_FORM = { name: '', location: '' };

export default function CollegeManagement() {
  // Seed from the last known response so the table paints immediately on
  // revisit; the live fetch below corrects it a moment later.
  const cachedColleges = readStale<College[]>(COLLEGES_PATH);
  const [colleges, setColleges] = useState<College[]>(
    Array.isArray(cachedColleges) ? cachedColleges : [],
  );
  const [loading, setLoading] = useState(!Array.isArray(cachedColleges));
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [confirmTarget, setConfirmTarget] = useState<College | null>(null);
  const [syncing, setSyncing] = useState(false);
  const hasRowsRef = useRef(colleges.length > 0);
  const toast = useToast();

  const isEditMode = Boolean(editingId);

  const fetchColleges = useCallback(async () => {
    // Only show the loading state when there is nothing to display; with
    // cached rows on screen a spinner would be a step backwards.
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
    }
  }, []);

  useEffect(() => {
    fetchColleges();
  }, [fetchColleges]);

  const resetModal = () => {
    setShowModal(false);
    setEditingId(null);
    setFormData(EMPTY_FORM);
  };

  const closeModal = () => {
    if (submitting) return;
    resetModal();
    setError('');
  };

  const openCreateModal = () => {
    setEditingId(null);
    setFormData(EMPTY_FORM);
    setError('');
    setShowModal(true);
  };

  const openEditModal = (college: College) => {
    setEditingId(String(college._id));
    setFormData({ name: college.name || '', location: college.location || '' });
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      // Update local state from the response rather than refetching the list,
      // so the table never blanks out between edits.
      const saved = await apiJson<{ id?: string }>(
        isEditMode ? `${COLLEGES_PATH}/${encodeURIComponent(editingId as string)}` : COLLEGES_PATH,
        { method: isEditMode ? 'PUT' : 'POST', body: formData },
      );
      invalidateCache(COLLEGES_PATH);
      if (isEditMode) {
        setColleges((current) => current.map((college) => (
          String(college._id) === editingId ? { ...college, ...formData } : college
        )));
      } else if (saved?.id) {
        setColleges((current) => [...current, { _id: saved.id as string, ...formData }]);
      }
      toast.success(isEditMode ? 'Institute updated' : 'Institute added', { detail: formData.name });
      resetModal();
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error(isEditMode ? 'Could not update institute' : 'Could not add institute', { detail: message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (college: College) => {
    setDeletingId(String(college._id));
    setError('');
    try {
      await apiFetch(`${COLLEGES_PATH}/${encodeURIComponent(college._id)}`, { method: 'DELETE' });
      invalidateCache(COLLEGES_PATH);
      // Remove the row locally once the server confirms; no refetch needed.
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

  /**
   * Imports the institute list from BigQuery and assigns synced instructors to
   * theirs. Both happen server-side; the list is reloaded afterwards rather
   * than patched, because linking changes instructors as well.
   */
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
          {/* Sync sits before Add: importing is the usual action, and adding
              one by hand is the exception. */}
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

      {error && !showModal && <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}

      <div className="bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden flex-1 flex flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-0 md:min-w-[700px]">
            <thead><tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider"><th className="p-4 hidden lg:table-cell">Institute ID</th><th className="p-4">Name</th><th className="p-4">Location</th><th className="p-4 text-right">Actions</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={4} className="p-8 text-center text-slate-400 font-medium">Loading institutes…</td></tr>
              ) : colleges.length === 0 ? (
                <tr><td colSpan={4} className="p-8 text-center text-slate-400 font-medium">No institutes found. Sync from BigQuery or add one to get started.</td></tr>
              ) : colleges.map((college) => (
                <tr key={college._id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-4 text-xs font-mono text-slate-400 hidden lg:table-cell">{college._id}</td>
                  <td className="p-4 font-bold text-slate-800">{college.name}</td>
                  <td className="p-4 text-sm font-medium text-slate-600">{college.location}</td>
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

      {showModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="college-dialog-title">
          <div className="bg-white rounded-md shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h2 id="college-dialog-title" className="text-xl font-extrabold text-slate-800 flex items-center gap-2"><Building2 size={20} className="text-indigo-600" aria-hidden="true" />{isEditMode ? 'Edit Institute' : 'Add New Institute'}</h2>
              <button type="button" aria-label="Close institute dialog" onClick={closeModal} disabled={submitting} className="text-slate-400 hover:text-slate-600 transition-colors bg-white px-2 py-1 rounded-full border border-slate-200 shadow-sm disabled:opacity-50">×</button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4">
              {error && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}
              <div><label htmlFor="college-name" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Institute Name</label><input id="college-name" required maxLength={120} placeholder="e.g. Training Institute" className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.name} onChange={(event) => setFormData({ ...formData, name: event.target.value })} /></div>
              <div><label htmlFor="college-location" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Location</label><input id="college-location" required maxLength={160} placeholder="e.g. Hyderabad" className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.location} onChange={(event) => setFormData({ ...formData, location: event.target.value })} /></div>
              <div className="pt-4 flex gap-3"><button type="button" onClick={closeModal} disabled={submitting} className="flex-1 px-4 py-3 rounded-md font-bold text-sm text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors disabled:opacity-50">Cancel</button><button type="submit" disabled={submitting} className="flex-1 px-4 py-3 rounded-md font-bold text-sm text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-200 disabled:opacity-50">{submitting ? 'Saving…' : isEditMode ? 'Save Changes' : 'Add Institute'}</button></div>
            </form>
          </div>
        </div>
      )}

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
