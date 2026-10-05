import { useCallback, useState, useEffect, useMemo, useRef, type FormEvent } from 'react';
import { Plus, UserCog, Search, Mail, CircleAlert, Upload, X } from 'lucide-react';
import { apiFetch, apiFetchAllPages, apiFetchCached, apiJson, invalidateCache, primeCache, readStale } from '../api';
import ConfirmDialog from './ConfirmDialog';
import InstructorGenderCell from './InstructorGenderCell';
import InstructorImportDialog from './InstructorImportDialog';
import ReferencePhotoField from './ReferencePhotoField';
import RowActionsMenu from './RowActionsMenu';
import { instructorRoleOptions } from '../instructorRoles';
import SearchableSelect from './SearchableSelect';
import { useToast } from './useToast';
import { CATEGORIES_PATH, categoryOptions, inUseCategories, type InstructorCategory } from '../lib/instructorCategories';
import { recordsPagePath } from '../lib/instructorRecords';
import { useLocation } from '../lib/useLocation';
import { closeChildPath, dialogPath, dialogRouteFromPath, goToPath, openChildPath, pathWithQuery, readQueryParam, writeQueryParams } from '../routes';
import type { College, Instructor } from '../types';

const INSTRUCTORS_PATH = '/api/v2/instructors?include_feedback=false';
const LIST_PATH = '/instructors';

interface InstructorForm {
  name: string;
  employee_id: string;
  instructor_user_id: string;
  instructor_category: string;
  role: string;
  gender: string;
  college_id: string;
  email: string;
  phone_no: string;
  [key: string]: string;
}

export default function InstructorManagement() {
  const cachedInstructors = readStale<Instructor[]>(INSTRUCTORS_PATH);
  const cachedColleges = readStale<College[]>('/api/v2/colleges');
  const cachedCategories = readStale<InstructorCategory[]>(CATEGORIES_PATH);
  const [instructors, setInstructors] = useState<Instructor[]>(
    Array.isArray(cachedInstructors) ? cachedInstructors : [],
  );
  const [colleges, setColleges] = useState<College[]>(
    Array.isArray(cachedColleges) ? cachedColleges : [],
  );
  const [loading, setLoading] = useState(!Array.isArray(cachedInstructors));
  const [fetched, setFetched] = useState(false);
  const [categories, setCategories] = useState<string[] | null>(
    Array.isArray(cachedCategories) ? cachedCategories.map((category) => category.name) : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState(() => readQueryParam('q'));
  const [confirmTarget, setConfirmTarget] = useState<Instructor | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [userIdLocked, setUserIdLocked] = useState(false);
  const toast = useToast();
  const { pathname } = useLocation();

  const [formData, setFormData] = useState<InstructorForm>({
    name: '',
    employee_id: '',
    instructor_user_id: '',
    instructor_category: '',
    role: '',
    gender: '',
    college_id: '',
    email: '',
    phone_no: ''
  });

  const fetchData = useCallback(async ({ signal }: { signal?: AbortSignal } = {}) => {
    try {
      const [instructorData, collegeData] = await Promise.all([
        apiFetchAllPages<Instructor>(INSTRUCTORS_PATH, {
          pageSize: 1_000,
          cacheMs: 15_000,
          signal,
        }),
        apiFetchCached<College[]>('/api/v2/colleges', { signal }),
      ]);
      if (signal?.aborted) return;
      if (Array.isArray(instructorData)) primeCache(INSTRUCTORS_PATH, instructorData);
      setInstructors(Array.isArray(instructorData) ? instructorData : []);
      setColleges(Array.isArray(collegeData) ? collegeData : []);
      setError('');
    } catch (requestError) {
      if (!signal?.aborted && (requestError as { status?: number })?.status !== 401) setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setFetched(true);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchData({ signal: controller.signal });
    return () => controller.abort();
  }, [fetchData]);

  useEffect(() => {
    let disposed = false;
    apiFetchCached<InstructorCategory[]>(CATEGORIES_PATH)
      .then((data) => {
        if (!disposed && Array.isArray(data)) setCategories(data.map((category) => category.name));
      })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    writeQueryParams({ q: search || null });
  }, [search]);

  const handleCreateOrUpdate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!formData.college_id) {
      setError('Please select an institute.');
      return;
    }
    if (!isEditMode && !pendingPhoto) {
      setError('Add a reference photo. It is what identifies this instructor at check-in.');
      return;
    }

    setSaving(true);
    try {
      const path = isEditMode ? `/api/v2/instructors/${encodeURIComponent(editingId as string)}` : '/api/v2/instructors';
      const saved = await apiJson<{ id?: string; instructor_user_id?: string }>(path, {
        method: isEditMode ? 'PUT' : 'POST',
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
          { _id: saved.id as string, ...formData, instructor_user_id: saved.instructor_user_id || formData.instructor_user_id, daily_feedbacks: [], face_count: 0 },
        ]);
      }

      let enrolled = true;
      if (!isEditMode && saved?.id && pendingPhoto) {
        try {
          const form = new FormData();
          form.append('photo', pendingPhoto, pendingPhoto.name || 'reference.jpg');
          form.append('mode', 'add');
          const face = await apiFetch<{ face_count?: number }>(
            `/api/v2/instructors/${encodeURIComponent(String(saved.id))}/face`,
            { method: 'POST', body: form, timeoutMs: 60_000 },
          );
          setInstructors((current) => current.map((ins) => (
            String(ins._id) === String(saved.id)
              ? { ...ins, face_count: face?.face_count ?? 1 }
              : ins
          )));
        } catch (faceError) {
          enrolled = false;
          const detail = faceError instanceof Error ? faceError.message : String(faceError);
          toast.error('Instructor saved, but the reference photo was not enrolled', { detail });
        }
      }

      if (enrolled) {
        toast.success(isEditMode ? 'Instructor updated' : 'Instructor added', { detail: formData.name });
      }
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
    const removedName = instructors.find((ins) => String(ins._id) === String(id))?.name;
    try {
      await apiFetch(`/api/v2/instructors/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      invalidateCache(INSTRUCTORS_PATH);
      setInstructors((current) => current.filter((ins) => String(ins._id) !== String(id)));
      toast.success('Instructor deleted', { detail: removedName });
      setConfirmTarget(null);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error('Could not delete instructor', { detail: message });
    }
  };

  const prepareAddModal = () => {
    setIsEditMode(false);
    setEditingId(null);
    setFormData({ name: '', employee_id: '', instructor_user_id: '', instructor_category: '', role: '', gender: '', college_id: '', email: '', phone_no: '' });
    setUserIdLocked(false);
    setPendingPhoto(null);
    setError('');
    setShowModal(true);
  };

  const prepareEditModal = (ins: Instructor) => {
    setIsEditMode(true);
    setEditingId(ins._id);
    setPendingPhoto(null);
    setError('');
    setFormData({
      name: ins.name,
      employee_id: ins.employee_id || '',
      instructor_user_id: ins.instructor_user_id || '',
      instructor_category: ins.instructor_category || '',
      role: ins.instructor_role || ins.role || '',
      gender: ins.gender ? String(ins.gender).toUpperCase() : '',
      college_id: ins.college_id,
      email: ins.email || '',
      phone_no: ins.phone_no || ''
    });
    setUserIdLocked(Boolean(ins.instructor_user_id));
    setShowModal(true);
  };

  const resetModal = () => {
    setShowModal(false);
    setIsEditMode(false);
    setEditingId(null);
    setPendingPhoto(null);
  };

  const listPath = () => pathWithQuery(LIST_PATH, { q: search });

  const openAddModal = () => {
    prepareAddModal();
    openChildPath(dialogPath(LIST_PATH, { view: 'new' }));
  };

  const openEditModal = (ins: Instructor) => {
    prepareEditModal(ins);
    openChildPath(dialogPath(LIST_PATH, { view: 'edit', id: String(ins._id) }));
  };

  const closeModal = () => {
    resetModal();
    closeChildPath(listPath());
  };

  const latest = useRef({ showModal, isEditMode, editingId, instructors, search });
  useEffect(() => {
    latest.current = { showModal, isEditMode, editingId, instructors, search };
  });

  useEffect(() => {
    const current = latest.current;
    const route = dialogRouteFromPath(pathname, LIST_PATH);
    if (route.view === 'new') {
      if (!current.showModal || current.isEditMode) prepareAddModal();
      return;
    }
    if (route.view === 'edit') {
      if (current.showModal && current.isEditMode && current.editingId === route.id) return;
      const target = current.instructors.find((ins) => String(ins._id) === route.id);
      if (target) {
        prepareEditModal(target);
      } else if (fetched) {
        resetModal();
        setError('That instructor was not found. They may have been removed.');
        goToPath(pathWithQuery(LIST_PATH, { q: current.search }), { replace: true });
      }
      return;
    }
    if (current.showModal) resetModal();
  }, [pathname, fetched]);

  const categoryChoices = useMemo(
    () => categoryOptions(categories ?? inUseCategories(instructors), formData.instructor_category),
    [categories, instructors, formData.instructor_category],
  );

  const roleOptions = useMemo(
    () => instructorRoleOptions(
      instructors.map((instructor) => instructor.instructor_role || instructor.role),
      formData.role,
    ),
    [instructors, formData.role],
  );

  const instituteFor = (ins: Instructor): string =>
    ins.institute_name
    || colleges.find((college) => String(college._id) === String(ins.college_id))?.name
    || '';

  const openRecords = (ins: Instructor) => openChildPath(recordsPagePath({ id: String(ins._id), name: ins.name }));

  const filteredInstructors = instructors.filter((ins) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return [
      ins.name,
      ins.employee_id,
      ins.instructor_user_id,
      ins.instructor_role,
      ins.role,
      instituteFor(ins),
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
        </div>
        <div className="flex items-center gap-3 flex-wrap w-full sm:w-auto">
          <div className="relative basis-full sm:basis-auto sm:flex-none">
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
            className="bg-indigo-600 text-white px-4 py-2.5 rounded-md font-bold text-sm flex flex-1 items-center justify-center gap-2 hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-200 shrink-0 sm:flex-none"
          >
            <Plus size={18} />
            Add Instructor
          </button>
          <button
            type="button"
            onClick={() => setShowImport(true)}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 shrink-0 sm:flex-none"
          >
            <Upload size={18} aria-hidden="true" />
            Import
          </button>
        </div>
      </div>

      {error && <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}

      <div className="md:hidden">
        {loading ? (
          <p className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm font-medium text-slate-400">Loading instructors...</p>
        ) : filteredInstructors.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm font-medium text-slate-400">No instructors found.</p>
        ) : (
          <>
            <p className="mb-2 px-1 text-xs font-semibold text-slate-500">{filteredInstructors.length} {filteredInstructors.length === 1 ? 'instructor' : 'instructors'}</p>
            <ul className="flex flex-col gap-3 pb-2">
              {filteredInstructors.map((ins) => (
                <li key={ins._id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <h3 className="flex items-center gap-1.5 text-[15px] font-bold text-slate-800">
                        <span className="truncate">{ins.name}</span>
                        {!ins.face_count && (
                          <span title="No reference photo: this instructor will not be recognised automatically" className="shrink-0">
                            <CircleAlert size={15} className="text-amber-500" aria-label="No reference photo" />
                          </span>
                        )}
                      </h3>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="inline-flex px-2 py-0.5 bg-indigo-50 text-indigo-700 font-bold text-[11px] rounded-md border border-indigo-100">
                          {ins.instructor_role || ins.role || '--'}
                        </span>
                        {instituteFor(ins) && <span className="min-w-0 truncate text-xs font-medium text-slate-500">{instituteFor(ins)}</span>}
                      </div>
                    </div>
                    <RowActionsMenu
                      label={`Actions for ${ins.name}`}
                      actions={[
                        { key: 'records', label: 'Records', icon: 'records', onSelect: () => openRecords(ins) },
                        { key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => openEditModal(ins) },
                        { key: 'delete', label: 'Delete', icon: 'delete', destructive: true, onSelect: () => setConfirmTarget(ins) },
                      ]}
                    />
                  </div>
                  {ins.email && (
                    <p className="mt-2 flex min-w-0 items-center gap-1.5 text-xs font-medium text-slate-500">
                      <Mail size={13} className="shrink-0 text-slate-400" aria-hidden="true" />
                      <span className="truncate">{ins.email}</span>
                    </p>
                  )}
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Gender</span>
                    <InstructorGenderCell
                      instructorId={String(ins._id)}
                      instructorName={ins.name}
                      value={ins.gender}
                      onSaved={(gender) => setInstructors((current) => current.map(
                        (row) => (row._id === ins._id ? { ...row, gender } : row),
                      ))}
                    />
                  </div>
                  {ins.instructor_category && (
                    <p className="mt-2 text-xs text-slate-500"><span className="font-semibold text-slate-400">Category:</span> {ins.instructor_category}</p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="hidden md:flex bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden flex-1 flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
                <th className="p-4">Instructor Name</th>
                <th className="p-4">Role</th>
                <th className="p-4">Gender</th>
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
                    <td className="p-4 font-bold text-slate-800">
                      <span className="flex items-center gap-1.5">
                        {ins.name}
                        {!ins.face_count && (
                          <span title="No reference photo: this instructor will not be recognised automatically">
                            <CircleAlert size={14} className="text-amber-500 shrink-0" aria-label="No reference photo" />
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="p-4">
                      <span className="inline-flex px-2.5 py-1 bg-indigo-50 text-indigo-700 font-bold text-[11px] rounded-md border border-indigo-100 whitespace-nowrap">
                        {ins.instructor_role || ins.role || '--'}
                      </span>
                    </td>
                    <td className="p-4">
                      <InstructorGenderCell
                        instructorId={String(ins._id)}
                        instructorName={ins.name}
                        value={ins.gender}
                        onSaved={(gender) => setInstructors((current) => current.map(
                          (row) => (row._id === ins._id ? { ...row, gender } : row),
                        ))}
                      />
                    </td>
                    <td className="p-4 hidden lg:table-cell text-sm text-slate-600">
                      {instituteFor(ins) || <span className="text-slate-300">--</span>}
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
                            { key: 'records', label: 'Records', icon: 'records', onSelect: () => openRecords(ins) },
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
          <div className="bg-white rounded-md shadow-xl w-full max-w-3xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h2 id="instructor-dialog-title" className="text-xl font-extrabold text-slate-800 flex items-center gap-2">
                <UserCog size={20} className="text-indigo-600" />
                {isEditMode ? 'Edit Instructor' : 'Add New Instructor'}
              </h2>
              <button
                type="button"
                aria-label="Close instructor dialog"
                title="Close"
                onClick={closeModal}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-rose-200 bg-rose-50 text-rose-600 shadow-sm transition-colors hover:border-rose-600 hover:bg-rose-600 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2"
              >
                <X size={18} strokeWidth={2.5} aria-hidden="true" />
              </button>
            </div>
            
            <form onSubmit={handleCreateOrUpdate} className="p-6 overflow-y-auto space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Full Name</label>
                  <input required maxLength={120} placeholder="John Doe" className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Employee ID</label>
                  <input required maxLength={50} placeholder="EMP123" className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all" value={formData.employee_id} onChange={e => setFormData({...formData, employee_id: e.target.value})} />
                </div>
                <div>
                  <label htmlFor="instructor-user-id" className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">User ID (Optional)</label>
                  <input
                    id="instructor-user-id"
                    maxLength={64}
                    pattern="[A-Za-z0-9_\-]{3,64}"
                    title="3 to 64 letters, numbers, - or _"
                    placeholder={isEditMode ? 'Not set' : 'Generated if left blank'}
                    readOnly={userIdLocked}
                    aria-describedby="instructor-user-id-hint"
                    className={`w-full rounded-md border border-slate-200 p-3 text-sm outline-none transition-all ${userIdLocked ? 'bg-slate-50 text-slate-500 cursor-not-allowed' : 'focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500'}`}
                    value={formData.instructor_user_id}
                    onChange={e => setFormData({...formData, instructor_user_id: e.target.value})}
                  />
                  <p id="instructor-user-id-hint" className="mt-1 text-[11px] text-slate-400">
                    {userIdLocked ? 'Set once; it links this instructor to Sync Data.' : isEditMode ? 'Optional. Fixed once saved.' : 'A random User ID is created if left blank.'}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Role</label>
                  <select required className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all bg-white" value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})}>
                    <option value="" disabled>Select a role...</option>
                    {roleOptions.map((role: string) => (
                      <option key={role} value={role}>{role}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Gender</label>
                  <select required className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all bg-white" value={formData.gender} onChange={e => setFormData({...formData, gender: e.target.value})}>
                    <option value="" disabled>Select gender...</option>
                    <option value="MALE">Male</option>
                    <option value="FEMALE">Female</option>
                  </select>
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label htmlFor="instructor-category" className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Category (Optional)</label>
                  <select id="instructor-category" className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all bg-white" value={formData.instructor_category} onChange={e => setFormData({...formData, instructor_category: e.target.value})}>
                    <option value="">No category</option>
                    {categoryChoices.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Assign Institute</label>
                <SearchableSelect
                    ariaLabel="Assign institute"
                    placeholder="Select an institute…"
                    value={formData.college_id}
                    onChange={(next) => setFormData({ ...formData, college_id: next })}
                    options={colleges.map((c) => ({ value: c._id, label: c.name, hint: c.location }))}
                  />
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

              <ReferencePhotoField
                mode={isEditMode ? 'edit' : 'create'}
                instructorId={isEditMode ? editingId : null}
                required={!isEditMode}
                onFileSelected={setPendingPhoto}
              />

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

      {showImport && (
        <InstructorImportDialog
          colleges={colleges}
          onClose={() => setShowImport(false)}
          onImported={(added) => {
            invalidateCache(INSTRUCTORS_PATH);
            void fetchData();
            toast.success(added === 1 ? 'Imported 1 instructor' : `Imported ${added} instructors`);
          }}
        />
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
