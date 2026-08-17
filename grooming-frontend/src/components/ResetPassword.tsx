import { useEffect, useState, type FormEvent } from 'react';
import PasswordInput from './PasswordInput';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import { useToast } from './useToast';

const MIN_LENGTH = 12;

interface ResetPasswordProps {
  token: string;
  /** Returns to the sign-in screen and clears the token from the URL. */
  onDone: () => void;
}

type TokenState = 'checking' | 'valid' | 'invalid';

export default function ResetPassword({ token, onDone }: ResetPasswordProps) {
  const [tokenState, setTokenState] = useState<TokenState>('checking');
  const [kind, setKind] = useState<'invite' | 'reset'>('reset');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const toast = useToast();

  // Check the link before showing the form, so an expired link says so
  // instead of failing only after the user has typed a password twice.
  useEffect(() => {
    let disposed = false;
    apiFetch<{ valid: boolean; email: string; kind: 'invite' | 'reset' }>(
      `/api/v2/auth/reset-password/${encodeURIComponent(token)}`,
      { auth: false },
    )
      .then((data) => {
        if (disposed) return;
        setTokenState('valid');
        setEmail(data.email || '');
        setKind(data.kind === 'invite' ? 'invite' : 'reset');
      })
      .catch((requestError) => {
        if (disposed) return;
        setTokenState('invalid');
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      });
    return () => {
      disposed = true;
    };
  }, [token]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      toast.error('Passwords do not match');
      return;
    }
    if (password.length < MIN_LENGTH) {
      setError(`Password must be at least ${MIN_LENGTH} characters.`);
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await apiJson('/api/v2/auth/reset-password', {
        method: 'POST',
        auth: false,
        body: { token, new_password: password, confirm_password: confirmPassword },
      });
      setDone(true);
      toast.success('Password set', { detail: 'You can sign in now.' });
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error('Could not set password', { detail: message });
    } finally {
      setSubmitting(false);
    }
  };

  const heading = kind === 'invite' ? 'Set your password' : 'Reset your password';

  return (
    <main className="min-h-[100svh] flex items-center justify-center bg-[#f8f9fc] p-4">
      <div className="bg-white p-6 sm:p-8 rounded-md shadow-xl w-full max-w-md border border-slate-100">
        <div className="flex flex-col items-center mb-6">
          <div className="w-12 h-12 sm:w-14 sm:h-14 mb-3 flex items-center justify-center">
            <img src="/logo.png" alt="FacultyTrack" className="w-full h-full object-contain" />
          </div>
          <h1 className="text-xl font-extrabold text-slate-800">{heading}</h1>
          {email && !done && (
            <p className="text-sm font-medium text-slate-500 mt-1 break-all text-center">{email}</p>
          )}
        </div>

        {tokenState === 'checking' && (
          <p className="text-center text-sm font-medium text-slate-400" role="status">
            Checking your link…
          </p>
        )}

        {tokenState === 'invalid' && (
          <div className="space-y-4">
            <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
              {error || 'This link is not valid.'}
            </div>
            <p className="text-sm text-slate-500">
              Password links can be used once and expire. Request a new one from the sign-in page.
            </p>
            <button
              type="button"
              onClick={onDone}
              className="w-full bg-[#8b5cf6] text-white py-3 rounded-md font-bold text-sm uppercase tracking-wider hover:bg-[#7c3aed] transition-colors"
            >
              Back to sign in
            </button>
          </div>
        )}

        {tokenState === 'valid' && done && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3">
              <ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />
              <p className="text-sm font-medium text-emerald-800">
                Your password is set. Sign in to continue.
              </p>
            </div>
            <button
              type="button"
              onClick={onDone}
              className="w-full bg-[#8b5cf6] text-white py-3 rounded-md font-bold text-sm uppercase tracking-wider hover:bg-[#7c3aed] transition-colors"
            >
              Go to sign in
            </button>
          </div>
        )}

        {tokenState === 'valid' && !done && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="reset-new-password" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                New Password
              </label>
              <PasswordInput
                id="reset-new-password"
                required
                minLength={MIN_LENGTH}
                maxLength={128}
                autoComplete="new-password"
                className="w-full rounded-md border border-slate-200 p-3 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none text-sm transition-all"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <p className="mt-1 text-xs text-slate-400">At least {MIN_LENGTH} characters.</p>
            </div>

            <div>
              <label htmlFor="reset-confirm-password" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                Confirm New Password
              </label>
              <PasswordInput
                id="reset-confirm-password"
                required
                minLength={MIN_LENGTH}
                maxLength={128}
                autoComplete="new-password"
                className="w-full rounded-md border border-slate-200 p-3 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none text-sm transition-all"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
              {confirmPassword && password !== confirmPassword && (
                <p className="mt-1 text-xs font-medium text-rose-600">Passwords do not match.</p>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-[#8b5cf6] text-white py-3 rounded-md font-bold text-sm uppercase tracking-wider flex items-center justify-center gap-2 hover:bg-[#7c3aed] transition-colors shadow-md shadow-indigo-200 disabled:opacity-70"
            >
              <KeyRound size={16} aria-hidden="true" />
              {submitting ? 'Saving…' : 'Set Password'}
            </button>

            <button
              type="button"
              onClick={onDone}
              className="w-full text-sm font-semibold text-slate-500 hover:text-slate-700 py-1"
            >
              Cancel
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
