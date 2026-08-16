import React, { useEffect, useMemo, useState } from 'react';
import { Edit2, Plus, Trash2, Users } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import { buildBoaPayload } from '../managementPayloads';

const EMPTY_FORM = { name: '', employee_id: '', email: '', password: '', college_id: '' };

export default function BOAManagement() {
  const [boas, setBoas] = useState([]);
  const [colleges, setColleges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState(EMPTY_FORM);

  const isEditMode = Boolean(editingId);
  const collegeNames = useMemo(
    () => new Map(colleges.map((college) => [String(college._id), college.name])),
    [colleges],
  );

  const fetchData = async () => {
    setLoading(true);
    try {
      const [boaData, collegeData] = await Promise.all([
        apiFetch('/api/v2/boas'),
        apiFetch('/api/v2/colleges'),
      ]);
      setBoas(Array.isArray(boaData) ? boaData : []);
      setColleges(Array.isArray(collegeData) ? collegeData : []);
      setError('');
    } catch (requestError) {
      if (requestError.status !== 401) setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
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

  const openEditModal = (boa) => {
    setEditingId(String(boa._id));
    setFormData({
      name: boa.name || '',
      employee_id: boa.employee_id || '',
      email: boa.email || '',
      password: '',
      college_id: String(boa.college_id || ''),
    });
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    const payload = buildBoaPayload(formData, { editing: isEditMode });

    try {
      await apiJson(
        isEditMode ? `/api/v2/boas/${encodeURIComponent(editingId)}` : '/api/v2/boas',
        { method: isEditMode ? 'PUT' : 'POST', body: payload },
      );
      resetModal();
      await fetchData();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (boa) => {
    if (!window.confirm(`Delete BOA “${boa.name}” and revoke this account’s access?`)) return;
    setDeletingId(String(boa._id));
    setError('');
    try {
      await apiFetch(`/api/v2/boas/${encodeURIComponent(boa._id)}`, { method: 'DELETE' });
      await fetchData();
    } catch (requestError) {
      if (requestError.status !== 401) setError(requestError.message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="w-full flex flex-col h-full" aria-labelledby="boa-title">
      <div className="flex justify-between items-center mb-6 gap-4 flex-wrap">
        <div>
          <h2 id="boa-title" className="text-xl font-extrabold text-slate-800 flex items-center gap-2"><Users size={24} className="text-indigo-600" aria-hidden="true" />Board of Administration</h2>
          <p className="text-sm text-slate-500 mt-1">Manage BOA access and college assignments.</p>
        </div>
        <button type="button" onClick={openCreateModal} disabled={colleges.length === 0} className="bg-indigo-600 text-white px-4 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-200 disabled:cursor-not-allowed disabled:opacity-50">
          <Plus size={18} aria-hidden="true" />Create New BOA
        </button>
      </div>

      {error && !showModal && <div role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}
      {!loading && colleges.length === 0 && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-700">Create a college before adding a BOA.</div>}

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex-1 flex flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[760px]">
            <thead><tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider"><th className="p-4">Name</th><th className="p-4">Employee ID</th><th className="p-4">College</th><th className="p-4">Registered Date</th><th className="p-4 text-right">Actions</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan="5" className="p-8 text-center text-slate-400">Loading BOAs…</td></tr>
              ) : boas.length === 0 ? (
                <tr><td colSpan="5" className="p-8 text-center text-slate-400">No BOAs found.</td></tr>
              ) : boas.map((boa) => (
                <tr key={boa._id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-4 font-bold text-slate-800">{boa.name}</td>
                  <td className="p-4 text-sm font-medium text-slate-600">{boa.employee_id}</td>
                  <td className="p-4 text-sm font-medium text-slate-600">{collegeNames.get(String(boa.college_id)) || 'Unknown college'}</td>
                  <td className="p-4 text-sm text-slate-500">{boa.created_at ? new Date(boa.created_at).toLocaleDateString() : '--'}</td>
                  <td className="p-4">
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" aria-label={`Edit ${boa.name}`} title={`Edit ${boa.name}`} disabled={Boolean(deletingId)} onClick={() => openEditModal(boa)} className="rounded-lg border border-indigo-100 bg-indigo-50 p-2 text-indigo-700 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"><Edit2 size={16} aria-hidden="true" /></button>
                      <button type="button" aria-label={`Delete ${boa.name}`} title={`Delete ${boa.name}`} disabled={Boolean(deletingId)} onClick={() => handleDelete(boa)} className="rounded-lg border border-rose-100 bg-rose-50 p-2 text-rose-700 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500 disabled:opacity-50"><Trash2 size={16} aria-hidden="true" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="boa-dialog-title">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h2 id="boa-dialog-title" className="text-xl font-extrabold text-slate-800">{isEditMode ? 'Edit BOA' : 'Create New BOA'}</h2>
              <button type="button" aria-label="Close BOA dialog" onClick={closeModal} disabled={submitting} className="text-slate-400 hover:text-slate-600 transition-colors disabled:opacity-50">×</button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4">
              {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}
              <div><label htmlFor="boa-name" className="block text-xs font-bold text-slate-500 uppercase mb-1">Full Name</label><input id="boa-name" required maxLength="120" autoComplete="name" className="w-full rounded-xl border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none" value={formData.name} onChange={(event) => setFormData({ ...formData, name: event.target.value })} /></div>
              <div><label htmlFor="boa-employee" className="block text-xs font-bold text-slate-500 uppercase mb-1">Employee ID</label><input id="boa-employee" required maxLength="50" className="w-full rounded-xl border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none" value={formData.employee_id} onChange={(event) => setFormData({ ...formData, employee_id: event.target.value })} /></div>
              <div><label htmlFor="boa-email" className="block text-xs font-bold text-slate-500 uppercase mb-1">Email</label><input id="boa-email" required type="email" maxLength="254" autoComplete="email" className="w-full rounded-xl border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none" value={formData.email} onChange={(event) => setFormData({ ...formData, email: event.target.value })} /></div>
              <div>
                <label htmlFor="boa-password" className="block text-xs font-bold text-slate-500 uppercase mb-1">{isEditMode ? 'New Password' : 'Temporary Password'}</label>
                <input id="boa-password" required={!isEditMode} type="password" minLength="12" maxLength="128" autoComplete="new-password" placeholder={isEditMode ? 'Leave blank to keep current password' : ''} className="w-full rounded-xl border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none" value={formData.password} onChange={(event) => setFormData({ ...formData, password: event.target.value })} />
                <p className="mt-1 text-xs text-slate-400">{isEditMode ? 'Leave blank to keep the current password; new passwords require at least 12 characters.' : 'Use at least 12 characters.'}</p>
              </div>
              <div><label htmlFor="boa-college" className="block text-xs font-bold text-slate-500 uppercase mb-1">College</label><select id="boa-college" required className="w-full rounded-xl border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none bg-white" value={formData.college_id} onChange={(event) => setFormData({ ...formData, college_id: event.target.value })}><option value="">Select a college…</option>{colleges.map((college) => <option key={college._id} value={college._id}>{college.name} — {college.location}</option>)}</select></div>

              <div className="pt-4 flex gap-3">
                <button type="button" onClick={closeModal} disabled={submitting} className="flex-1 px-4 py-3 rounded-xl font-bold text-sm text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors disabled:opacity-50">Cancel</button>
                <button type="submit" disabled={submitting} className="flex-1 px-4 py-3 rounded-xl font-bold text-sm text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-200 disabled:opacity-50">{submitting ? 'Saving…' : isEditMode ? 'Save Changes' : 'Create BOA'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
