import React, { useEffect, useState } from 'react';
import { Building2, Edit2, Plus, Trash2 } from 'lucide-react';
import { apiFetch, apiJson } from '../api';

const EMPTY_FORM = { name: '', location: '' };

export default function CollegeManagement() {
  const [colleges, setColleges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState(EMPTY_FORM);

  const isEditMode = Boolean(editingId);

  const fetchColleges = async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/api/v2/colleges');
      setColleges(Array.isArray(data) ? data : []);
      setError('');
    } catch (requestError) {
      if (requestError.status !== 401) setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchColleges();
  }, []);

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

  const openEditModal = (college) => {
    setEditingId(String(college._id));
    setFormData({ name: college.name || '', location: college.location || '' });
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await apiJson(
        isEditMode ? `/api/v2/colleges/${encodeURIComponent(editingId)}` : '/api/v2/colleges',
        { method: isEditMode ? 'PUT' : 'POST', body: formData },
      );
      resetModal();
      await fetchColleges();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (college) => {
    if (!window.confirm(`Delete college “${college.name}”? Reassign active BOAs and instructors first.`)) return;
    setDeletingId(String(college._id));
    setError('');
    try {
      await apiFetch(`/api/v2/colleges/${encodeURIComponent(college._id)}`, { method: 'DELETE' });
      await fetchColleges();
    } catch (requestError) {
      if (requestError.status !== 401) setError(requestError.message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="w-full flex flex-col h-full animate-in fade-in duration-300" aria-labelledby="college-title">
      <div className="flex justify-between items-center mb-6 shrink-0 gap-4 flex-wrap">
        <div>
          <h2 id="college-title" className="text-xl font-extrabold text-slate-800 flex items-center gap-2"><Building2 size={24} className="text-indigo-600" aria-hidden="true" />College Management</h2>
          <p className="text-sm text-slate-500 mt-1">Manage partner colleges and campuses.</p>
        </div>
        <button type="button" onClick={openCreateModal} className="bg-indigo-600 text-white px-4 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-200"><Plus size={18} aria-hidden="true" />Add New College</button>
      </div>

      {error && !showModal && <div role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex-1 flex flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[700px]">
            <thead><tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider"><th className="p-4">College ID</th><th className="p-4">Name</th><th className="p-4">Location</th><th className="p-4 text-right">Actions</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan="4" className="p-8 text-center text-slate-400 font-medium">Loading colleges…</td></tr>
              ) : colleges.length === 0 ? (
                <tr><td colSpan="4" className="p-8 text-center text-slate-400 font-medium">No colleges found. Add one to get started.</td></tr>
              ) : colleges.map((college) => (
                <tr key={college._id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-4 text-xs font-mono text-slate-400">{college._id}</td>
                  <td className="p-4 font-bold text-slate-800">{college.name}</td>
                  <td className="p-4 text-sm font-medium text-slate-600">{college.location}</td>
                  <td className="p-4">
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" aria-label={`Edit ${college.name}`} title={`Edit ${college.name}`} disabled={Boolean(deletingId)} onClick={() => openEditModal(college)} className="rounded-lg border border-indigo-100 bg-indigo-50 p-2 text-indigo-700 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"><Edit2 size={16} aria-hidden="true" /></button>
                      <button type="button" aria-label={`Delete ${college.name}`} title={`Delete ${college.name}`} disabled={Boolean(deletingId)} onClick={() => handleDelete(college)} className="rounded-lg border border-rose-100 bg-rose-50 p-2 text-rose-700 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500 disabled:opacity-50"><Trash2 size={16} aria-hidden="true" /></button>
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
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h2 id="college-dialog-title" className="text-xl font-extrabold text-slate-800 flex items-center gap-2"><Building2 size={20} className="text-indigo-600" aria-hidden="true" />{isEditMode ? 'Edit College' : 'Add New College'}</h2>
              <button type="button" aria-label="Close college dialog" onClick={closeModal} disabled={submitting} className="text-slate-400 hover:text-slate-600 transition-colors bg-white px-2 py-1 rounded-full border border-slate-200 shadow-sm disabled:opacity-50">×</button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4">
              {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}
              <div><label htmlFor="college-name" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">College Name</label><input id="college-name" required maxLength="120" placeholder="e.g. NxtWave Campus A" className="w-full rounded-xl border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.name} onChange={(event) => setFormData({ ...formData, name: event.target.value })} /></div>
              <div><label htmlFor="college-location" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Location</label><input id="college-location" required maxLength="160" placeholder="e.g. Hyderabad" className="w-full rounded-xl border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.location} onChange={(event) => setFormData({ ...formData, location: event.target.value })} /></div>
              <div className="pt-4 flex gap-3"><button type="button" onClick={closeModal} disabled={submitting} className="flex-1 px-4 py-3 rounded-xl font-bold text-sm text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors disabled:opacity-50">Cancel</button><button type="submit" disabled={submitting} className="flex-1 px-4 py-3 rounded-xl font-bold text-sm text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-200 disabled:opacity-50">{submitting ? 'Saving…' : isEditMode ? 'Save Changes' : 'Add College'}</button></div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
