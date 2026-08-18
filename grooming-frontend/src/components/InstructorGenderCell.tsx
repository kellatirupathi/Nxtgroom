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

/**
 * Gender, editable in place.
 *
 * The AI is told the instructor's gender so it compares the photo against the
 * right reference examples; without it, everyone is judged against both men's
 * and women's standards. Synced instructors arrive without one and the roster
 * has no such field, so this is the only way the value ever gets set — which
 * is why it is a single click in the table rather than a trip through the
 * edit dialog.
 */
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
    // Applied immediately: the select would otherwise snap back to the old
    // value until the request returned, which reads as a failed click.
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
      // Put the old value back rather than leaving the table showing a change
      // the database never accepted.
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
        {/* Unset is a real state, not a default: showing "Male" for a record
            with no gender would hide exactly the rows that need attention. */}
        <option value="" disabled>Not set</option>
        <option value="MALE">Male</option>
        <option value="FEMALE">Female</option>
      </select>
      {saving && <RefreshCw size={13} className="animate-spin text-slate-400" aria-hidden="true" />}
      {!saving && justSaved && <Check size={14} className="text-emerald-600" aria-hidden="true" />}
    </div>
  );
}
