import { useState, useEffect, useMemo, type FormEvent } from 'react';
import { Plus, UserCog, Search, Mail } from 'lucide-react';
import { apiFetch, apiFetchAllPages, apiFetchCached, apiJson, invalidateCache, primeCache, readStale } from '../api';
import ConfirmDialog from './ConfirmDialog';
import RowActionsMenu from './RowActionsMenu';
import { useToast } from './useToast';
import type { College, Instructor } from '../types';

const INSTRUCTORS_PATH = '/api/v2/instructors';

interface InstructorForm {
  name: string;
  employee_id: string;
  role: string;
  gender: string;
  college_id: string;
  email: string;
  phone_no: string;
  [key: string]: string;
}

export default function InstructorManagement() {
  // Paint from the last known lists, then revalidate in the background.
  const cachedInstructors = readStale<Instructor[]>(INSTRUCTORS_PATH);
  const cachedColleges = readStale<College[]>('/api/v2/colleges');
  const [instructors, setInstructors] = useState<Instructor[]>(
    Array.isArray(cachedInstructors) ? cachedInstructors : [],
  );
  const [colleges, setColleges] = useState<College[]>(
    Array.isArray(cachedColleges) ? cachedColleges : [],
  );
  const [loading, setLoading] = useState(!Array.isArray(cachedInstructors));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [confirmTarget, setConfirmTarget] = useState<Instructor | null>(null);
  const toast = useToast();

  const [formData, setFormData] = useState<InstructorForm>({
    name: '',
    employee_id: '',
    role: '',
    gender: 'MALE',
    college_id: '',
    email: '',
    phone_no: ''
  });

  const fetchData = async ({ signal }: { signal?: AbortSignal } = {}) => {
    // Skip the blank state when cached rows are already rendered.
    if (instructors.length === 0) setLoading(true);
    try {
      const [instructorData, collegeData] = await Promise.all([
        apiFetchAllPages<Instructor>(INSTRUCTORS_PATH, { pageSize: 100, signal }),
        apiFetchCached<College[]>('/api/v2/colleges', { signal }),
      ]);
      if (signal?.aborted) return;
      // Pagination assembles the list across requests, so store the finished
      // array under the base path for the next visit to paint from.
      if (Array.isArray(instructorData)) primeCache(INSTRUCTORS_PATH, instructorData);
      setInstructors(Array.isArray(instructorData) ? instructorData : []);
      setColleges(Array.isArray(collegeData) ? collegeData : []);
      setError('');
    } catch (requestError) {
      if (!signal?.aborted && (requestError as { status?: number })?.status !== 401) setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    fetchData({ signal: controller.signal });
    return () => controller.abort();
  }, []);

  const handleCreateOrUpdate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!formData.college_id) {
      setError('Please select an institute.');
      return;
    }

    setSaving(true);
    try {
      const path = isEditMode ? `/api/v2/instructors/${encodeURIComponent(editingId as string)}` : '/api/v2/instructors';
      // Patch local state from the response instead of refetching the whole
      // list, so the table updates in place with no loading blank.
      const saved = await apiJson<{ id?: string }>(path, {
        method: isEditMode ? 'PUT' : 'POST',
        // instructor_role is what the tables display, so it is sent alongside
        // role; otherwise an edit would save but appear to change nothing.
        body: { ...formData, instructor_role: formData.role },
      });
      invalidateCache(INSTRUCTORS_PATH);
      if (isEditMode) {
        setInstructors((current) => current.map((ins) => (
          String(ins._id) === editingId
            ? { ...ins, ...formData, instructor_role: formData.role }
            : ins
        )));
      } else if (saved?.id) {
        setInstructors((current) => [
          ...current,
          { _id: saved.id as string, ...formData, daily_feedbacks: [] },
        ]);
      }
      toast.success(isEditMode ? 'Instructor updated' : 'Instructor added', { detail: formData.name });
      closeModal();
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error(isEditMode ? 'Could not update instructor' : 'Could not add instructor', { detail: message });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    // Read the name before the row leaves state so the toast can name it.
    const removedName = instructors.find((ins) => String(ins._id) === String(id))?.name;
    try {
      await apiFetch(`/api/v2/instructors/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      invalidateCache(INSTRUCTORS_PATH);
      // Drop the row locally once the server confirms; no refetch needed.
      setInstructors((current) => current.filter((ins) => String(ins._id) !== String(id)));
      toast.success('Instructor deleted', { detail: removedName });
      setConfirmTarget(null);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error('Could not delete instructor', { detail: message });
    }
  };

  const openAddModal = () => {
    setIsEditMode(false);
    setEditingId(null);
    setFormData({ name: '', employee_id: '', role: '', gender: 'MALE', college_id: '', email: '', phone_no: '' });
    setShowModal(true);
  };

  const openEditModal = (ins: Instructor) => {
    setIsEditMode(true);
    setEditingId(ins._id);
    setFormData({
      name: ins.name,
      employee_id: ins.employee_id || '',
      role: ins.instructor_role || ins.role || '',
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

  /**
   * Every distinct role in the roster, plus the one being edited so an unusual
   * value is never silently replaced by the first option when the form opens.
   */
  const roleOptions = useMemo(() => {
    const roles = new Set<string>();
    for (const instructor of instructors) {
      const role = instructor.instructor_role || instructor.role;
      if (role) roles.add(role);
    }
    if (formData.role) roles.add(formData.role);
    // A fallback only when the roster is empty, so the form is never unusable.
    if (roles.size === 0) ["INSTRUCTOR", "CENTRAL_INSTRUCTOR"].forEach((role) => roles.add(role));
    return [...roles].sort((a, b) => a.localeCompare(b));
  }, [instructors, formData.role]);

  // Search covers the synced columns too, since employee_id is often absent
  // on roster rows and the user id is what identifies them.
  const filteredInstructors = instructors.filter((ins) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return [
      ins.name,
      ins.employee_id,
      ins.instructor_user_id,
      ins.instructor_role,
      ins.role,
      ins.institute_name,
      ins.instructor_category,
      ins.email,
    ].some((value) => String(value ?? '').toLowerCase().includes(term));
  });

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
        <div className="flex items-center gap-3 flex-wrap w-full sm:w-auto">
          <div className="relative flex-1 min-w-[10rem] sm:flex-none">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text" 
              placeholder="Search instructors..." 
              className="pl-10 pr-4 py-2.5 rounded-md border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none w-full sm:w-64 shadow-sm transition-all"
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
                <th className="p-4 hidden xl:table-cell">Instructor User ID</th>
                <th className="p-4">Instructor Name</th>
                <th className="p-4">Role</th>
                {/* Institute replaces College: they name the same thing, and
                    the roster is authoritative for it. */}
                <th className="p-4 hidden lg:table-cell">Institute</th>
                <th className="p-4 hidden lg:table-cell">Category</th>
                <th className="p-4 hidden xl:table-cell">Email</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-400 font-medium">Loading instructors...</td>
                </tr>
              ) : filteredInstructors.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-400 font-medium">No instructors found.</td>
                </tr>
              ) : (
                filteredInstructors.map(ins => (
                  <tr key={ins._id} className="hover:bg-slate-50 transition-colors group">
                    {/* Employee ID is optional on synced rows, so the stable
                        identifier is the instructor_user_id from BigQuery. */}
                    <td className="p-4 hidden xl:table-cell text-xs font-mono font-medium text-slate-500">
                      {ins.instructor_user_id || ins.employee_id || <span className="text-slate-300">--</span>}
                    </td>
                    <td className="p-4 font-bold text-slate-800">{ins.name}</td>
                    <td className="p-4">
                      <span className="inline-flex px-2.5 py-1 bg-indigo-50 text-indigo-700 font-bold text-[11px] rounded-md border border-indigo-100 whitespace-nowrap">
                        {ins.instructor_role || ins.role || '--'}
                      </span>
                    </td>
                    <td className="p-4 hidden lg:table-cell text-sm text-slate-600">
                      {ins.institute_name || <span className="text-slate-300">--</span>}
                    </td>
                    <td className="p-4 hidden lg:table-cell text-sm text-slate-600">
                      {ins.instructor_category || <span className="text-slate-300">--</span>}
                    </td>
                    <td className="p-4 hidden xl:table-cell text-xs font-medium text-slate-500">
                      {ins.email ? (
                        <span className="flex items-center gap-1.5"><Mail size={12} className="text-slate-400 shrink-0" aria-hidden="true" /> {ins.email}</span>
                      ) : <span className="text-slate-300">--</span>}
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex justify-end">
                        <RowActionsMenu
                          label={`Actions for ${ins.name}`}
                          actions={[
                            { key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => openEditModal(ins) },
                            { key: 'delete', label: 'Delete', icon: 'delete', destructive: true, onSelect: () => setConfirmTarget(ins) },
                          ]}
                        />
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
                  <input required maxLength={120} placeholder="John Doe" className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Employee ID</label>
                  <input required maxLength={50} placeholder="EMP123" className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.employee_id} onChange={e => setFormData({...formData, employee_id: e.target.value})} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Role</label>
                  {/* Options come from the roles present in the roster, not a
                      fixed list: the synced data uses CENTRAL_INSTRUCTOR and
                      INSTRUCTOR, which the old hardcoded three did not include,
                      so editing a synced instructor silently changed their role. */}
                  <select required className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all bg-white" value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})}>
                    {/* An empty value must match an option, or the browser
                        shows the first role while the form still holds "",
                        which the server then rejects. */}
                    <option value="" disabled>Select a role...</option>
                    {roleOptions.map((role: string) => (
                      <option key={role} value={role}>{role}</option>
                    ))}
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
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Assign Institute</label>
                <select required className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all bg-white" value={formData.college_id} onChange={e => setFormData({...formData, college_id: e.target.value})}>
                  <option value="" disabled>Select an institute...</option>
                  {colleges.map(c => (
                    <option key={c._id} value={c._id}>{c.name} - {c.location}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Email</label>
                  <input required type="email" maxLength={254} placeholder="john@example.com" className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Phone (Optional)</label>
                  <input maxLength={30} placeholder="+1 234 567 8900" className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.phone_no} onChange={e => setFormData({...formData, phone_no: e.target.value})} />
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

      <ConfirmDialog
        open={Boolean(confirmTarget)}
        destructive
        title="Remove instructor"
        message={`Remove ${confirmTarget?.name ?? 'this instructor'} from active records?`}
        detail="Their past attendance and evaluation history is kept."
        confirmLabel="Remove"
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => confirmTarget && handleDelete(confirmTarget._id)}
      />
    </div>
  );
}
