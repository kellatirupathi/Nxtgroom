import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MailCheck } from 'lucide-react';
import { apiJson } from '../api';

interface ForgotPasswordDialogProps {
  open: boolean;
  /** Prefills the field with whatever was already typed on the sign-in form. */
  initialEmail?: string;
  onClose: () => void;
}

export default function ForgotPasswordDialog({ open, initialEmail = '', onClose }: ForgotPasswordDialogProps) {
  const [email, setEmail] = useState(initialEmail);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    setEmail(initialEmail);
    setSent(false);
    setError('');
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // submitting is deliberately excluded: re-running on each keystroke of the
    // request would reset the form mid-submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialEmail, onClose]);

  if (!open) return null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await apiJson('/api/v2/auth/forgot-password', {
        method: 'POST',
        auth: false,
        body: { email: email.trim().toLowerCase() },
      });
      // The server answers identically for known and unknown addresses, so the
      // UI must not imply the account exists either.
      setSent(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="forgot-password-title"
    >
      <div className="w-full max-w-md overflow-hidden rounded-md border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 bg-slate-50/50 px-5 py-4">
          <h2 id="forgot-password-title" className="text-lg font-extrabold text-slate-800">
            Forgot password
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            We will email you a link to choose a new password.
          </p>
        </div>

        {sent ? (
          <div className="space-y-4 p-5">
            <div className="flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3">
              <MailCheck size={18} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />
              <p className="text-sm font-medium text-emerald-800">
                If that email has an account, a reset link is on its way. The link expires in one hour.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-md bg-[#8b5cf6] px-4 py-3 text-sm font-bold uppercase tracking-wider text-white hover:bg-[#7c3aed]"
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 p-5">
            {error && (
              <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
                {error}
              </div>
            )}
            <div>
              <label htmlFor="forgot-email" className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">
                Email
              </label>
              <input
                ref={inputRef}
                id="forgot-email"
                required
                type="email"
                maxLength={254}
                autoComplete="username"
                className="w-full rounded-md border border-slate-200 bg-slate-50 p-3 text-sm outline-none transition-all focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-500/20"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@nxtwave.com"
              />
            </div>
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="flex-1 rounded-md bg-slate-100 px-4 py-3 text-sm font-bold text-slate-600 hover:bg-slate-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 rounded-md bg-[#8b5cf6] px-4 py-3 text-sm font-bold text-white hover:bg-[#7c3aed] disabled:opacity-70"
              >
                {submitting ? 'Sending…' : 'Send Link'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
