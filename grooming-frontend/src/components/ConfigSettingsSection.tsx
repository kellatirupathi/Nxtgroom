import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import { Toggle } from './SettingsPage';
import { useToast } from './useToast';
import type { ConfigSettings } from '../types';

const CONFIG_PATH = '/api/v2/settings/config';

export default function ConfigSettingsSection() {
  const [settings, setSettings] = useState<ConfigSettings>({ allow_move_while_checked_in: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let disposed = false;
    apiFetch<ConfigSettings>(CONFIG_PATH)
      .then((data) => {
        if (!disposed && data) setSettings(data);
      })
      .catch(() => {
        if (!disposed) toast.error('Could not load the config settings');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => { disposed = true; };
  }, [toast]);

  const update = async (key: keyof ConfigSettings, value: boolean) => {
    const previous = settings;
    setSettings({ ...settings, [key]: value });
    setSaving(true);
    try {
      const saved = await apiJson<ConfigSettings>(CONFIG_PATH, {
        method: 'PUT',
        body: { [key]: value },
      });
      setSettings(saved);
      toast.success(
        value ? 'Checked-in instructors can now be moved' : 'Instructors must check out before moving',
        { detail: value ? 'An instructor can move to another institute before checking out.' : 'Moving a checked-in instructor to another institute is blocked again.' },
      );
    } catch (error) {
      setSettings(previous);
      toast.error('Could not save the setting', {
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="config-settings">
      <h3 id="config-settings" className="flex items-center gap-2 text-sm font-bold text-slate-800 mb-3">
        <SlidersHorizontal size={16} className="text-indigo-600" aria-hidden="true" />
        Config
      </h3>
      <div className="bg-white border border-slate-200 rounded-md">
        <div className="flex items-start justify-between gap-3 sm:gap-6 p-4">
          <div className="min-w-0">
            <label htmlFor="allow_move_while_checked_in" className="block text-sm font-semibold text-slate-800">
              Allow moving a checked-in instructor to another institute
            </label>
            <p className="text-sm text-slate-500 mt-0.5">
              When on, an instructor who has checked in today but not yet checked out can be moved to
              another institute, from Instructors or an import. Today&rsquo;s check-in stays with the
              institute where it was made. When off, they must check out before they can be moved.
            </p>
          </div>
          <Toggle
            id="allow_move_while_checked_in"
            checked={settings.allow_move_while_checked_in}
            disabled={loading || saving}
            onChange={(value) => void update('allow_move_while_checked_in', value)}
          />
        </div>
      </div>
    </section>
  );
}
