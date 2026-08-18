import { useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import { Toggle } from './SettingsPage';
import { useToast } from './useToast';
import type { UserPermissions } from '../types';

interface UserPermissionsModalProps {
  userId: string;
  email: string;
  onClose: () => void;
}

const SOURCE_NOTE: Record<UserPermissions['source'], string> = {
  ROLE: 'Administrators can always delete records. This cannot be turned off.',
  USER: 'Set for this account, so the workspace default does not apply to them.',
  WORKSPACE: 'Following the workspace default. Changing it here applies to this account only.',
};

/**
 * One account's deletion permission.
 *
 * Shows where the current answer comes from, because a switch that is on
 * because the workspace allows it behaves differently from one somebody chose
 * for this person: changing the workspace default moves the first and leaves
 * the second alone, and the two are indistinguishable without saying so.
 */
export default function UserPermissionsModal({ userId, email, onClose }: UserPermissionsModalProps) {
  const [permissions, setPermissions] = useState<UserPermissions | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const path = `/api/v2/users/${encodeURIComponent(userId)}/permissions`;

  useEffect(() => {
    let disposed = false;
    apiFetch<UserPermissions>(path)
      .then((data) => {
        if (!disposed) setPermissions(data);
      })
      .catch((error) => {
        if (disposed) return;
        toast.error('Could not load permissions', {
          detail: error instanceof Error ? error.message : String(error),
        });
        onClose();
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => { disposed = true; };
  }, [path, toast, onClose]);

  const save = async (value: boolean | null) => {
    setSaving(true);
    try {
      const saved = await apiJson<UserPermissions>(path, {
        method: 'PUT',
        body: { can_delete_records: value },
      });
      setPermissions((current) => ({ ...(current || {}), ...saved }));
      toast.success('Permissions updated', {
        detail: value === null
          ? `${email} now follows the workspace default.`
          : `${email} ${value ? 'can' : 'cannot'} delete attendance records.`,
      });
    } catch (error) {
      toast.error('Could not update permissions', {
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const locked = permissions?.source === 'ROLE';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="permissions-title"
    >
      <div className="w-full max-w-md overflow-hidden rounded-md bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <h2 id="permissions-title" className="flex items-center gap-2 text-lg font-bold text-slate-800">
            <ShieldCheck size={18} className="text-indigo-600" aria-hidden="true" />
            Permissions
          </h2>
          <button
            type="button"
            aria-label="Close permissions dialog"
            onClick={onClose}
            className="rounded-md border border-slate-200 px-2 py-1 text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>

        <div className="p-5">
          <p className="mb-4 break-all text-sm font-semibold text-slate-700">{email}</p>

          {loading ? (
            <p className="flex items-center gap-2 py-6 text-sm text-slate-500" role="status">
              <RefreshCw size={15} className="animate-spin" aria-hidden="true" />
              Loading permissions…
            </p>
          ) : permissions ? (
            <>
              <div className="flex items-start justify-between gap-5 rounded-md border border-slate-200 p-4">
                <div className="min-w-0">
                  <label htmlFor="can-delete-records" className="block text-sm font-semibold text-slate-800">
                    Delete attendance records
                  </label>
                  <p className="mt-0.5 text-sm text-slate-500">
                    Removes the check-in, its appearance report and both photographs. This cannot be undone.
                  </p>
                </div>
                <Toggle
                  id="can-delete-records"
                  checked={permissions.can_delete_records}
                  disabled={saving || locked}
                  onChange={(value) => void save(value)}
                />
              </div>

              <p className="mt-3 text-xs text-slate-500">{SOURCE_NOTE[permissions.source]}</p>

              {permissions.source === 'USER' && (
                <button
                  type="button"
                  onClick={() => void save(null)}
                  disabled={saving}
                  className="mt-3 text-xs font-semibold text-indigo-600 hover:text-indigo-700 hover:underline disabled:opacity-50"
                >
                  Follow the workspace default instead
                  {` (currently ${permissions.workspace_default ? 'allowed' : 'not allowed'})`}
                </button>
              )}
            </>
          ) : null}

          <button
            type="button"
            onClick={onClose}
            className="mt-5 w-full rounded-md bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-200"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
