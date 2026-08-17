import React, { useState, useEffect } from 'react';
import { Plus, UserCog, Search, Mail, Phone, Building2, Edit2, Trash2 } from 'lucide-react';
import { apiFetch, apiFetchAllPages, apiJson } from '../api';

export default function InstructorManagement() {
  const [instructors, setInstructors] = useState([]);
  const [colleges, setColleges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [search, setSearch] = useState('');
  
  const [formData, setFormData] = useState({
    name: '',
    employee_id: '',
    role: 'Trainee',
    gender: 'MALE',
    college_id: '',
    email: '',
    phone_no: ''
  });

  const fetchData = async ({ signal } = {}) => {
    setLoading(true);
    try {
      const [instructorData, collegeData] = await Promise.all([
        apiFetchAllPages('/api/v2/instructors', { pageSize: 100, signal }),
        apiFetch('/api/v2/colleges', { signal }),
      ]);
      if (signal?.aborted) return;
      setInstructors(Array.isArray(instructorData) ? instructorData : []);
      setColleges(Array.isArray(collegeData) ? collegeData : []);
      setError('');
    } catch (requestError) {
      if (!signal?.aborted && requestError.status !== 401) setError(requestError.message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    fetchData({ signal: controller.signal });
    return () => controller.abort();
  }, []);

  const handleCreateOrUpdate = async (e) => {
    e.preventDefault();
    if (!formData.college_id) {
      setError('Please select a college.');
      return;
    }

    setSaving(true);
    try {
      const path = isEditMode ? `/api/v2/instructors/${encodeURIComponent(editingId)}` : '/api/v2/instructors';
      await apiJson(path, {
        method: isEditMode ? 'PUT' : 'POST',
        body: formData,
      });
      closeModal();
      await fetchData();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Remove this instructor from active records?")) return;
    try {
      await apiFetch(`/api/v2/instructors/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      await fetchData();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const openAddModal = () => {
    setIsEditMode(false);
    setEditingId(null);
    setFormData({ name: '', employee_id: '', role: 'Trainee', gender: 'MALE', college_id: '', email: '', phone_no: '' });
    setShowModal(true);
  };

  const openEditModal = (ins) => {
    setIsEditMode(true);
    setEditingId(ins._id);
    setFormData({
      name: ins.name,
      employee_id: ins.employee_id,
      role: ins.role || 'Trainee',
      gender: String(ins.gender || 'MALE').toUpperCase(),
      college_id: ins.college_id,
      email: ins.email || '',
      phone_no: ins.phone_no || ''
    });
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setIsEditMode(false);
    setEditingId(null);
  };

  const getCollegeName = (collegeId) => {
    const col = colleges.find(c => c._id === collegeId);
    return col ? col.name : <span className="text-slate-400 font-mono text-xs">{collegeId}</span>;
  };

  const filteredInstructors = instructors.filter(ins => 
    (ins.name || '').toLowerCase().includes(search.toLowerCase()) || 
    (ins.employee_id || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="w-full flex flex-col h-full animate-in fade-in duration-300">
      <div className="flex justify-between items-center mb-6 shrink-0 gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-extrabold text-slate-800 flex items-center gap-2">
            <UserCog size={24} className="text-indigo-600" />
            Instructor Management
          </h2>
          <p className="text-sm text-slate-500 mt-1">Manage instructor profiles and college assignments.</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text" 
              placeholder="Search instructors..." 
              className="pl-10 pr-4 py-2.5 rounded-md border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none w-64 shadow-sm transition-all"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        <button
            type="button"
            onClick={openAddModal}
            className="bg-indigo-600 text-white px-4 py-2.5 rounded-md font-bold text-sm flex items-center gap-2 hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-200 shrink-0"
          >
            <Plus size={18} />
            Add Instructor
          </button>
        </div>
      </div>

      {error && <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}

      <div className="bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden flex-1 flex flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
                <th className="p-4">Employee ID</th>
                <th className="p-4">Instructor Name</th>
                <th className="p-4">Role</th>
                <th className="p-4">College</th>
                <th className="p-4">Contact</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="6" className="p-8 text-center text-slate-400 font-medium">Loading instructors...</td>
                </tr>
              ) : filteredInstructors.length === 0 ? (
                <tr>
                  <td colSpan="6" className="p-8 text-center text-slate-400 font-medium">No instructors found.</td>
                </tr>
              ) : (
                filteredInstructors.map(ins => (
                  <tr key={ins._id} className="hover:bg-slate-50 transition-colors group">
                    <td className="p-4 text-xs font-mono font-medium text-slate-500">{ins.employee_id}</td>
                    <td className="p-4 font-bold text-slate-800">
                      {ins.name}
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider mt-0.5">{ins.gender}</div>
                    </td>
                    <td className="p-4">
                      <span className="inline-flex px-2.5 py-1 bg-indigo-50 text-indigo-700 font-bold text-[11px] rounded-md border border-indigo-100">
                        {ins.role}
                      </span>
                    </td>
                    <td className="p-4 text-sm font-semibold text-slate-700 flex items-center gap-1.5 pt-5">
                      <Building2 size={14} className="text-slate-400" />
                      {getCollegeName(ins.college_id)}
                    </td>
                    <td className="p-4">
                      <div className="flex flex-col gap-1.5">
                        {ins.email ? <span className="text-xs font-medium text-slate-500 flex items-center gap-1.5"><Mail size={12} className="text-slate-400"/> {ins.email}</span> : <span className="text-xs text-slate-300">-</span>}
                        {ins.phone_no ? <span className="text-xs font-medium text-slate-500 flex items-center gap-1.5"><Phone size={12} className="text-slate-400"/> {ins.phone_no}</span> : null}
                      </div>
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button type="button" aria-label={`Edit ${ins.name}`} title={`Edit ${ins.name}`} onClick={() => openEditModal(ins)} className="rounded-md border border-indigo-100 bg-indigo-50 p-2 text-indigo-700 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                          <Edit2 size={16} aria-hidden="true" />
                        </button>
                        <button type="button" aria-label={`Remove ${ins.name}`} title={`Remove ${ins.name}`} onClick={() => handleDelete(ins._id)} className="rounded-md border border-rose-100 bg-rose-50 p-2 text-rose-700 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500">
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in zoom-in-95 duration-200" role="dialog" aria-modal="true" aria-labelledby="instructor-dialog-title">
          <div className="bg-white rounded-md shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h2 id="instructor-dialog-title" className="text-xl font-extrabold text-slate-800 flex items-center gap-2">
                <UserCog size={20} className="text-indigo-600" />
                {isEditMode ? 'Edit Instructor' : 'Add New Instructor'}
              </h2>
              <button type="button" aria-label="Close instructor dialog" onClick={closeModal} className="text-slate-400 hover:text-slate-600 transition-colors bg-white p-1 rounded-full border border-slate-200 shadow-sm">
                ✕
              </button>
            </div>
            
            <form onSubmit={handleCreateOrUpdate} className="p-6 overflow-y-auto space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Full Name</label>
                  <input required maxLength="120" placeholder="John Doe" className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Employee ID</label>
                  <input required maxLength="50" placeholder="EMP123" className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.employee_id} onChange={e => setFormData({...formData, employee_id: e.target.value})} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Role</label>
                  <select required className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all bg-white" value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})}>
                    <option value="Trainee">Trainee</option>
                    <option value="Senior Instructor">Senior Instructor</option>
                    <option value="Lead Instructor">Lead Instructor</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Gender</label>
                  <select required className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all bg-white" value={formData.gender} onChange={e => setFormData({...formData, gender: e.target.value})}>
                    <option value="MALE">Male</option>
                    <option value="FEMALE">Female</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Assign College</label>
                <select required className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all bg-white" value={formData.college_id} onChange={e => setFormData({...formData, college_id: e.target.value})}>
                  <option value="" disabled>Select a college...</option>
                  {colleges.map(c => (
                    <option key={c._id} value={c._id}>{c.name} - {c.location}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Email</label>
                  <input required type="email" maxLength="254" placeholder="john@example.com" className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Phone (Optional)</label>
                  <input maxLength="30" placeholder="+1 234 567 8900" className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.phone_no} onChange={e => setFormData({...formData, phone_no: e.target.value})} />
                </div>
              </div>

              <div className="pt-6 flex gap-3">
                <button type="button" onClick={closeModal} disabled={saving} className="flex-1 px-4 py-3 rounded-md font-bold text-sm text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors disabled:opacity-50">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 px-4 py-3 rounded-md font-bold text-sm text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-200 disabled:opacity-50">
                  {saving ? 'Saving…' : isEditMode ? 'Save Changes' : 'Create Instructor'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
