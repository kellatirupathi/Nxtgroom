import { useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { apiJson } from '../api';
import { useToast } from './useToast';

interface InstructorGenderCellProps {
  instructorId: string;
  instructorName: string;
  value: string | null | undefined;
  onSaved: (gender: string) => void;
}

export default function InstructorGenderCell({
  instructorId,
  instructorName,
  value,
  onSaved,
}: InstructorGenderCellProps) {
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const toast = useToast();
  const current = String(value || '').toUpperCase();

  const save = async (next: string) => {
    if (!next || next === current) return;
    setSaving(true);
    onSaved(next);
    try {
      await apiJson(`/api/v2/instructors/${encodeURIComponent(instructorId)}/gender`, {
        method: 'PATCH',
        body: { gender: next },
      });
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 2000);
      toast.success('Gender updated', {
        detail: `${instructorName} is now recorded as ${next === 'MALE' ? 'Male' : 'Female'}.`,
      });
    } catch (error) {
      onSaved(current);
      toast.error('Could not update gender', {
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <select
        aria-label={`Gender for ${instructorName}`}
        disabled={saving}
        value={current}
        onChange={(event) => void save(event.target.value)}
        className={`rounded-md border px-2 py-1.5 text-xs font-semibold outline-none transition-colors focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 disabled:opacity-60 ${
          current
            ? 'border-slate-200 bg-white text-slate-700'
            : 'border-amber-200 bg-amber-50 text-amber-700'
        }`}
      >
        <option value="" disabled>Not set</option>
        <option value="MALE">Male</option>
        <option value="FEMALE">Female</option>
      </select>
      {saving && <RefreshCw size={13} className="animate-spin text-slate-400" aria-hidden="true" />}
      {!saving && justSaved && <Check size={14} className="text-emerald-600" aria-hidden="true" />}
    </div>
  );
}
