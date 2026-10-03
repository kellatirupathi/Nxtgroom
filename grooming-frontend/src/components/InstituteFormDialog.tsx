import { useEffect, useState, type FormEvent } from 'react';
import { Building2, X } from 'lucide-react';
import { apiJson, invalidateCache } from '../api';
import { useToast } from './useToast';
import type { College } from '../types';

const COLLEGES_PATH = '/api/v2/colleges';

const INPUT_CLASS = 'w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all';
const LABEL_CLASS = 'block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1';

interface InstituteFormDialogProps {
  open: boolean;
  college: College | null;
  onClose: () => void;
  onSaved: (college: College, wasEdit: boolean) => void;
}

export default function InstituteFormDialog({ open, college, onClose, onSaved }: InstituteFormDialogProps) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const isEdit = Boolean(college);

  useEffect(() => {
    if (!open) return;
    setName(college?.name ?? '');
    setLocation(college?.location ?? '');
    setError('');
  }, [open, college]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const close = () => {
    if (!submitting) onClose();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = { name: name.trim(), location: location.trim() };
    const missing = [
      body.name.length < 2 && 'an institute name',
      body.location.length < 2 && 'a location',
    ].filter(Boolean);
    if (missing.length) {
      setError(`Enter ${missing.join(' and ')} of at least 2 characters.`);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const saved = await apiJson<{ id?: string }>(
        isEdit ? `${COLLEGES_PATH}/${encodeURIComponent(String(college?._id))}` : COLLEGES_PATH,
        { method: isEdit ? 'PUT' : 'POST', body },
      );
      invalidateCache(COLLEGES_PATH);
      const id = isEdit ? String(college?._id) : String(saved?.id ?? '');
      toast.success(isEdit ? 'Institute updated' : 'Institute added', { detail: body.name });
      onSaved({ _id: id, ...body }, isEdit);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error(isEdit ? 'Could not update institute' : 'Could not add institute', { detail: message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="institute-dialog-title">
      <div className="bg-white rounded-md shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
          <h2 id="institute-dialog-title" className="text-xl font-extrabold text-slate-800 flex items-center gap-2">
            <Building2 size={20} className="text-indigo-600" aria-hidden="true" />
            {isEdit ? 'Edit Institute' : 'Add New Institute'}
          </h2>
          <button
            type="button"
            aria-label="Close institute dialog"
            title="Close"
            onClick={close}
            disabled={submitting}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-rose-200 bg-rose-50 text-rose-600 shadow-sm transition-colors hover:border-rose-600 hover:bg-rose-600 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 disabled:opacity-50"
          >
            <X size={18} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4" noValidate>
          {error && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}
          <div>
            <label htmlFor="institute-name" className={LABEL_CLASS}>
              Institute Name <span className="text-rose-600" aria-hidden="true">*</span>
            </label>
            <input
              id="institute-name"
              required
              aria-required="true"
              minLength={2}
              maxLength={120}
              autoFocus
              placeholder="e.g. Training Institute"
              className={INPUT_CLASS}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="institute-location" className={LABEL_CLASS}>
              Location <span className="text-rose-600" aria-hidden="true">*</span>
            </label>
            <input
              id="institute-location"
              required
              aria-required="true"
              minLength={2}
              maxLength={160}
              placeholder="e.g. Hyderabad"
              className={INPUT_CLASS}
              value={location}
              onChange={(event) => setLocation(event.target.value)}
            />
          </div>
          <div className="pt-4 flex gap-3">
            <button type="button" onClick={close} disabled={submitting} className="flex-1 px-4 py-3 rounded-md font-bold text-sm text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={submitting} className="flex-1 px-4 py-3 rounded-md font-bold text-sm text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-200 disabled:opacity-50">
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Institute'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
