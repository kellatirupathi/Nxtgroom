import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, Users as UsersIcon, ShieldCheck } from 'lucide-react';
import { apiFetch, apiJson, invalidateCache } from '../api';
import RowActionsMenu, { type RowAction } from './RowActionsMenu';
import type { AdminUser, Boa, College, Role } from '../types';

const ADMINS_PATH = '/api/v2/admins';
const BOAS_PATH = '/api/v2/boas';

/** One row of the combined table; `kind` decides which endpoints apply. */
interface UserRow {
  id: string;
  kind: 'admin' | 'boa';
  name: string;
  email: string;
  employeeId: string;
  role: Role;
  collegeId: string;
  collegeName: string;
  createdAt?: string | null;
  isSuperAdmin: boolean;
}

interface FormState {
  role: 'ADMIN' | 'BOA';
  name: string;
  employee_id: string;
  email: string;
  password: string;
  college_id: string;
}

const EMPTY_FORM: FormState = {
  role: 'BOA',
  name: '',
  employee_id: '',
  email: '',
  password: '',
  college_id: '',
};

function RoleTag({ role }: { role: Role }) {
  const styles: Record<Role, string> = {
    SUPER_ADMIN: 'bg-violet-50 text-violet-700 border-violet-200',
    ADMIN: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    BOA: 'bg-slate-100 text-slate-600 border-slate-200',
  };
  const labels: Record<Role, string> = {
    SUPER_ADMIN: 'Super Admin',
    ADMIN: 'Admin',
    BOA: 'BOA',
  };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2.5 py-1 text-[11px] font-bold ${styles[role]}`}>
      {role !== 'BOA' && <ShieldCheck size={12} aria-hidden="true" />}
      {labels[role]}
    </span>
  );
}

interface UserManagementProps {
  currentRole: Role | null;
  currentEmail: string | null;
}

export default function UserManagement({ currentRole, currentEmail }: UserManagementProps) {
  const isSuper = currentRole === 'SUPER_ADMIN';
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [boas, setBoas] = useState<Boa[]>([]);
  const [colleges, setColleges] = useState<College[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const [passwordFor, setPasswordFor] = useState<UserRow | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const fetchAll = async () => {
    setLoading(true);
    try {
      // Only the super admin may list administrators; an admin still sees BOAs.
      const [boaData, collegeData, adminData] = await Promise.all([
        apiFetch<Boa[]>(BOAS_PATH),
        apiFetch<College[]>('/api/v2/colleges'),
        isSuper ? apiFetch<AdminUser[]>(ADMINS_PATH) : Promise.resolve([]),
      ]);
      setBoas(Array.isArray(boaData) ? boaData : []);
      setColleges(Array.isArray(collegeData) ? collegeData : []);
      setAdmins(Array.isArray(adminData) ? adminData : []);
      setError('');
    } catch (requestError) {
      if ((requestError as { status?: number })?.status !== 401) {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuper]);

  const collegeNames = useMemo(
    () => new Map(colleges.map((college) => [String(college._id), college.name])),
    [colleges],
  );

  const rows: UserRow[] = useMemo(() => {
    const adminRows: UserRow[] = admins.map((admin) => ({
      id: String(admin._id),
      kind: 'admin',
      name: admin.name || admin.email,
      email: admin.email,
      employeeId: '--',
      role: admin.role,
      collegeId: '',
      collegeName: 'All colleges',
      createdAt: admin.created_at,
      isSuperAdmin: admin.role === 'SUPER_ADMIN',
    }));
    const boaRows: UserRow[] = boas.map((boa) => ({
      id: String(boa._id),
      kind: 'boa',
      name: boa.name,
      email: boa.email || '--',
      employeeId: boa.employee_id,
      role: 'BOA',
      collegeId: String(boa.college_id),
      collegeName: collegeNames.get(String(boa.college_id)) || 'Unknown college',
      createdAt: boa.created_at,
      isSuperAdmin: false,
    }));
    // Administrators first: they are fewer and more privileged.
    return [...adminRows, ...boaRows];
  }, [admins, boas, collegeNames]);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, role: isSuper ? 'ADMIN' : 'BOA' });
    setError('');
    setShowForm(true);
  };

  const openEdit = (row: UserRow) => {
    setEditing(row);
    setForm({
      role: row.kind === 'admin' ? 'ADMIN' : 'BOA',
      name: row.name,
      employee_id: row.employeeId === '--' ? '' : row.employeeId,
      email: row.email === '--' ? '' : row.email,
      password: '',
      college_id: row.collegeId,
    });
    setError('');
    setShowForm(true);
  };

  const closeForm = () => {
    if (submitting) return;
    setShowForm(false);
    setEditing(null);
    setError('');
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      if (form.role === 'ADMIN') {
        const body: Record<string, unknown> = { name: form.name, email: form.email };
        if (form.password) body.password = form.password;
        if (editing) {
          await apiJson(`${ADMINS_PATH}/${encodeURIComponent(editing.id)}`, { method: 'PUT', body });
        } else {
          await apiJson(ADMINS_PATH, { method: 'POST', body: { ...body, password: form.password } });
        }
        invalidateCache(ADMINS_PATH);
      } else {
        const body: Record<string, unknown> = {
          name: form.name,
          employee_id: form.employee_id,
          email: form.email,
          college_id: form.college_id,
        };
        if (form.password) body.password = form.password;
        if (editing) {
          await apiJson(`${BOAS_PATH}/${encodeURIComponent(editing.id)}`, { method: 'PUT', body });
        } else {
          await apiJson(BOAS_PATH, { method: 'POST', body: { ...body, password: form.password } });
        }
        invalidateCache(BOAS_PATH);
      }
      setShowForm(false);
      setEditing(null);
      setNotice(editing ? 'User updated successfully.' : 'User created successfully.');
      await fetchAll();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    if (!passwordFor) return;
    setSubmitting(true);
    setError('');
    try {
      const base = passwordFor.kind === 'admin' ? ADMINS_PATH : BOAS_PATH;
      await apiJson(`${base}/${encodeURIComponent(passwordFor.id)}/password`, {
        method: 'POST',
        body: { new_password: newPassword },
      });
      setPasswordFor(null);
      setNewPassword('');
      setConfirmPassword('');
      setNotice('Password updated. That user must sign in again.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (row: UserRow) => {
    if (!window.confirm(`Delete ${row.name}? This cannot be undone.`)) return;
    setError('');
    try {
      const base = row.kind === 'admin' ? ADMINS_PATH : BOAS_PATH;
      await apiFetch(`${base}/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
      invalidateCache(base);
      setNotice(`${row.name} was deleted.`);
      await fetchAll();
    } catch (requestError) {
      if ((requestError as { status?: number })?.status !== 401) {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
    }
  };

  const actionsFor = (row: UserRow): RowAction[] => {
    // Administrator accounts are managed by the super admin alone, and the
    // super admin row itself can never be deleted.
    const manageable = row.kind === 'boa' || isSuper;
    const isSelf = row.email === currentEmail;
    return [
      { key: 'edit', label: 'Edit', icon: 'edit', disabled: !manageable, onSelect: () => openEdit(row) },
      {
        key: 'password',
        label: 'Set new password',
        icon: 'password',
        disabled: !manageable,
        onSelect: () => {
          setPasswordFor(row);
          setNewPassword('');
          setConfirmPassword('');
          setError('');
        },
      },
      {
        key: 'delete',
        label: 'Delete',
        icon: 'delete',
        destructive: true,
        disabled: !manageable || row.isSuperAdmin || isSelf,
        onSelect: () => handleDelete(row),
      },
    ];
  };

  const inputClass =
    'w-full rounded-md border border-slate-300 p-2.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

  return (
    <section className="w-full flex flex-col h-full" aria-labelledby="users-title">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="users-title" className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <UsersIcon size={22} className="text-indigo-600" aria-hidden="true" />
            Users
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            {isSuper
              ? 'Manage administrators and BOA accounts.'
              : 'Manage BOA accounts. Only the super admin can manage administrators.'}
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="bg-indigo-600 text-white px-4 py-2.5 rounded-md font-bold text-sm flex items-center gap-2 hover:bg-indigo-700 transition-colors"
        >
          <Plus size={18} aria-hidden="true" />
          Add User
        </button>
      </div>

      {error && !showForm && !passwordFor && (
        <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>
      )}
      {notice && (
        <div role="status" className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-700">{notice}</div>
      )}

      <div className="bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden flex-1 flex flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
                <th className="p-4">Name</th>
                <th className="p-4">Role</th>
                <th className="p-4 hidden md:table-cell">Email</th>
                <th className="p-4 hidden xl:table-cell">Employee ID</th>
                <th className="p-4 hidden lg:table-cell">College</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={6} className="p-8 text-center text-slate-400 font-medium">Loading users…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="p-8 text-center text-slate-400 font-medium">No users found.</td></tr>
              ) : rows.map((row) => (
                <tr key={`${row.kind}-${row.id}`} className="hover:bg-slate-50 transition-colors">
                  <td className="p-4 font-bold text-slate-800">{row.name}</td>
                  <td className="p-4"><RoleTag role={row.role} /></td>
                  <td className="p-4 hidden md:table-cell text-sm text-slate-600">{row.email}</td>
                  <td className="p-4 hidden xl:table-cell text-sm text-slate-600">{row.employeeId}</td>
                  <td className="p-4 hidden lg:table-cell text-sm text-slate-600">{row.collegeName}</td>
                  <td className="p-4 text-right">
                    <RowActionsMenu label={row.name} actions={actionsFor(row)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="user-form-title">
          <div className="bg-white rounded-md shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-5 border-b border-slate-200 flex justify-between items-center">
              <h3 id="user-form-title" className="text-lg font-bold text-slate-800">{editing ? 'Edit User' : 'Add User'}</h3>
              <button type="button" onClick={closeForm} disabled={submitting} className="text-slate-400 hover:text-slate-600 border border-slate-200 px-2 py-1 rounded-md disabled:opacity-50">×</button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto">
              {error && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}

              <div>
                <label htmlFor="user-role" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Role</label>
                <select
                  id="user-role"
                  value={form.role}
                  disabled={Boolean(editing)}
                  onChange={(event) => setForm({ ...form, role: event.target.value as 'ADMIN' | 'BOA' })}
                  className={`${inputClass} disabled:bg-slate-50 disabled:text-slate-500`}
                >
                  {isSuper && <option value="ADMIN">Admin — full access, all colleges</option>}
                  <option value="BOA">BOA — scoped to one college</option>
                </select>
                {editing && <p className="mt-1 text-xs text-slate-400">Role cannot be changed after creation.</p>}
              </div>

              <div>
                <label htmlFor="user-name" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Full name</label>
                <input id="user-name" required minLength={2} maxLength={120} className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              </div>

              <div>
                <label htmlFor="user-email" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Email</label>
                <input id="user-email" required type="email" maxLength={254} className={inputClass} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
                <p className="mt-1 text-xs text-slate-400">Used for sign-in, including Google sign-in.</p>
              </div>

              {form.role === 'BOA' && (
                <>
                  <div>
                    <label htmlFor="user-employee" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Employee ID</label>
                    <input id="user-employee" required maxLength={50} className={inputClass} value={form.employee_id} onChange={(event) => setForm({ ...form, employee_id: event.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="user-college" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">College</label>
                    <select id="user-college" required className={inputClass} value={form.college_id} onChange={(event) => setForm({ ...form, college_id: event.target.value })}>
                      <option value="">Select a college</option>
                      {colleges.map((college) => <option key={college._id} value={college._id}>{college.name}</option>)}
                    </select>
                  </div>
                </>
              )}

              <div>
                <label htmlFor="user-password" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">
                  {editing ? 'New password (optional)' : 'Password'}
                </label>
                <input id="user-password" required={!editing} type="password" minLength={12} maxLength={128} autoComplete="new-password" className={inputClass} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
                <p className="mt-1 text-xs text-slate-400">{editing ? 'Leave blank to keep the current password.' : 'Minimum 12 characters.'}</p>
              </div>

              <div className="pt-1 flex gap-3">
                <button type="button" onClick={closeForm} disabled={submitting} className="flex-1 px-4 py-2.5 rounded-md font-semibold text-sm text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50">Cancel</button>
                <button type="submit" disabled={submitting} className="flex-1 px-4 py-2.5 rounded-md font-semibold text-sm text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50">{submitting ? 'Saving…' : editing ? 'Save Changes' : 'Create User'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {passwordFor && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="set-password-title">
          <div className="bg-white rounded-md shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-5 border-b border-slate-200 flex justify-between items-center">
              <h3 id="set-password-title" className="text-lg font-bold text-slate-800">Set new password</h3>
              <button type="button" onClick={() => setPasswordFor(null)} disabled={submitting} className="text-slate-400 hover:text-slate-600 border border-slate-200 px-2 py-1 rounded-md disabled:opacity-50">×</button>
            </div>
            <form onSubmit={handleSetPassword} className="p-5 space-y-4 overflow-y-auto">
              {error && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}
              <p className="text-sm text-slate-600">Setting a new password for <strong className="font-semibold text-slate-800">{passwordFor.name}</strong>.</p>
              <div>
                <label htmlFor="set-new-password" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">New password</label>
                <input id="set-new-password" required type="password" minLength={12} maxLength={128} autoComplete="new-password" className={inputClass} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
                <p className="mt-1 text-xs text-slate-400">Minimum 12 characters.</p>
              </div>
              <div>
                <label htmlFor="set-confirm-password" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Confirm password</label>
                <input id="set-confirm-password" required type="password" minLength={12} maxLength={128} autoComplete="new-password" className={inputClass} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
              </div>
              <p className="text-xs text-slate-500">This signs that user out of all devices.</p>
              <div className="pt-1 flex gap-3">
                <button type="button" onClick={() => setPasswordFor(null)} disabled={submitting} className="flex-1 px-4 py-2.5 rounded-md font-semibold text-sm text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50">Cancel</button>
                <button type="submit" disabled={submitting} className="flex-1 px-4 py-2.5 rounded-md font-semibold text-sm text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50">{submitting ? 'Saving…' : 'Update Password'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
