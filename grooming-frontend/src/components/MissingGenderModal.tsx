import { useEffect, useRef, useState } from 'react';
import { RefreshCw, UserRound, X } from 'lucide-react';
import { apiJson, invalidateCache } from '../api';
import type { Instructor } from '../types';
import { useToast } from './useToast';

interface MissingGenderModalProps {
  instructor: Instructor;
  onClose: () => void;
  onSaved: (instructorId: string, gender: string) => void;
}

/** Collects a required profile field at the point where it is first needed. */
export default function MissingGenderModal({
  instructor,
  onClose,
  onSaved,
}: MissingGenderModalProps) {
  const [gender, setGender] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    selectRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, saving]);

  const save = async () => {
    if (!gender) {
      setError('Select Male or Female to continue.');
      selectRef.current?.focus();
      return;
    }
    setSaving(true);
    setError('');
    try {
      await apiJson(`/api/v2/instructors/${encodeURIComponent(instructor._id)}/gender`, {
        method: 'PATCH',
        body: { gender },
      });
      // The attendance roster is cached for fast reloads. Do not allow that
      // cache to restore the missing value after this confirmed mutation.
      invalidateCache('/api/v2/instructors');
      onSaved(instructor._id, gender);
      toast.success('Gender updated', {
        detail: `${instructor.name} is now recorded as ${gender === 'MALE' ? 'Male' : 'Female'}.`,
      });
      onClose();
    } catch (saveError) {
      const detail = saveError instanceof Error ? saveError.message : String(saveError);
      setError(detail);
      toast.error('Could not update gender', { detail });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[115] flex items-center justify-center bg-slate-950/55 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="missing-gender-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h2 id="missing-gender-title" className="text-lg font-extrabold text-slate-800">
              Add instructor gender
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Gender is required to apply the correct appearance standards.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close gender dialog"
            className="ml-3 rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="p-5">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-end">
            <div className="min-w-0">
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">
                Selected instructor
              </p>
              <div className="flex min-h-11 items-center gap-3 rounded-md bg-slate-50 px-3 py-2.5">
                <UserRound size={18} className="shrink-0 text-indigo-600" aria-hidden="true" />
                <span className="truncate text-sm font-bold text-slate-800">{instructor.name}</span>
              </div>
            </div>
            <label className="block">
              <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-400">
                Gender
              </span>
              <select
                ref={selectRef}
                value={gender}
                disabled={saving}
                onChange={(event) => {
                  setGender(event.target.value);
                  setError('');
                }}
                className="min-h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 disabled:opacity-60"
              >
                <option value="">Select gender</option>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
              </select>
            </label>
          </div>

          {error && <p role="alert" className="mt-3 text-sm font-medium text-rose-600">{error}</p>}

          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="mt-5 flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 text-sm font-bold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving && <RefreshCw size={16} className="animate-spin" aria-hidden="true" />}
            {saving ? 'Saving…' : 'Save gender'}
          </button>
        </div>
      </div>
    </div>
  );
}
