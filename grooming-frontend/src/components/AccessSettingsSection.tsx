import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import { Toggle } from './SettingsPage';
import { useToast } from './useToast';
import type { AccessSettings } from '../types';

const ACCESS_PATH = '/api/v2/settings/access';

/**
 * Who, besides administrators, may delete an attendance record.
 *
 * Kept apart from the notification preferences above: those decide what gets
 * emailed, this decides who can destroy a record and its photographs. Off
 * until somebody turns it on, and individual accounts can still be granted or
 * refused it under Users regardless of what is set here.
 */
export default function AccessSettingsSection() {
  const [settings, setSettings] = useState<AccessSettings>({ boa_can_delete_records: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let disposed = false;
    apiFetch<AccessSettings>(ACCESS_PATH)
      .then((data) => {
        if (!disposed && data) setSettings(data);
      })
      .catch(() => {
        // A failed read leaves the safe default showing rather than an empty
        // control that looks switched off but was never loaded.
        if (!disposed) toast.error('Could not load permission settings');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => { disposed = true; };
  }, [toast]);

  const update = async (value: boolean) => {
    const previous = settings;
    setSettings({ boa_can_delete_records: value });
    setSaving(true);
    try {
      const saved = await apiJson<AccessSettings>(ACCESS_PATH, {
        method: 'PUT',
        body: { boa_can_delete_records: value },
      });
      setSettings(saved);
      toast.success(
        value ? 'BOAs can now delete records' : 'BOAs can no longer delete records',
        { detail: 'Accounts with their own setting under Users are unaffected.' },
      );
    } catch (error) {
      setSettings(previous);
      toast.error('Could not save the permission', {
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="access-settings" className="mt-8">
      <h3 id="access-settings" className="flex items-center gap-2 text-sm font-bold text-slate-800 mb-3">
        <ShieldCheck size={16} className="text-indigo-600" aria-hidden="true" />
        Permissions
      </h3>
      <div className="bg-white border border-slate-200 rounded-md">
        <div className="flex items-start justify-between gap-6 p-4">
          <div className="min-w-0">
            <label htmlFor="boa_can_delete_records" className="block text-sm font-semibold text-slate-800">
              Let BOAs delete attendance records
            </label>
            <p className="text-sm text-slate-500 mt-0.5">
              Deleting removes the check-in, its appearance report and both photographs, and cannot be
              undone. Administrators can always delete. A BOA given their own setting under Users keeps
              it whatever this is.
            </p>
          </div>
          <Toggle
            id="boa_can_delete_records"
            checked={settings.boa_can_delete_records}
            disabled={loading || saving}
            onChange={(value) => void update(value)}
          />
        </div>
      </div>
    </section>
  );
}
