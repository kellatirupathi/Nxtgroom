import { useState, type FormEvent } from 'react';
import PasswordInput from './PasswordInput';
import { ArrowRight } from 'lucide-react';
import { apiFetch, saveSession } from '../api';
import GoogleSignInButton from './GoogleSignInButton';
import ForgotPasswordDialog from './ForgotPasswordDialog';
import { useToast } from './useToast';
import type { LoginResponse, Role } from '../types';

interface LoginProps {
  onLogin: (token: string, role: Role) => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showForgot, setShowForgot] = useState(false);
  const toast = useToast();

  const reportSignInError = (message: string) => {
    setError(message);
    if (/not authorised|not authorized/i.test(message)) {
      toast.error('This Google account is not registered', {
        detail: 'Ask an administrator to add your email under Users, then sign in again.',
      });
      return;
    }
    toast.error('Sign-in failed', { detail: message });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const formData = new URLSearchParams({ username: username.trim(), password });
      const data = await apiFetch<LoginResponse>('/api/v2/auth/login', {
        method: 'POST',
        auth: false,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData,
      });

      if (!data?.access_token || !['SUPER_ADMIN', 'ADMIN', 'BOA'].includes(data.role)) {
        throw new Error('The server returned an invalid login response.');
      }
      saveSession(data.access_token, data.role);
      onLogin(data.access_token, data.role);
    } catch (requestError) {
      reportSignInError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-[calc(100svh-var(--shell-offset-top))] flex flex-col bg-[#f8f9fc] overflow-y-auto sm:items-center sm:justify-center sm:p-6">
      <div className="flex flex-col items-center px-6 pb-8 pt-16 text-center sm:pt-0">
        <div className="flex h-[88px] w-[88px] items-center justify-center rounded-3xl border border-indigo-100 bg-white shadow-[0_8px_24px_-8px_rgba(79,70,229,0.35)]">
          <img src="/logo.png" alt="" className="h-16 w-16 object-contain" />
        </div>
        <h1 className="mt-5 text-[26px] font-extrabold tracking-tight text-slate-900">FacultyTrack</h1>
        <p className="mt-1.5 text-[15px] text-slate-500">Instructor attendance and grooming</p>
      </div>

      <div className="flex flex-1 flex-col rounded-t-[28px] bg-white px-6 pb-[max(1.5rem,var(--inset-bottom))] pt-7 shadow-[0_-8px_30px_rgba(15,23,42,0.06)] sm:w-full sm:max-w-md sm:flex-none sm:rounded-[28px] sm:border sm:border-slate-100 sm:p-8 sm:shadow-xl">
        <h2 className="mb-5 text-xl font-bold text-slate-900">Sign in</h2>

        {error && (
          <div role="alert" className="mb-4 rounded-xl border border-rose-100 bg-rose-50 p-3 text-center text-sm font-medium text-rose-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-[18px]">
          <div>
            <label htmlFor="login-email" className="mb-2 block text-[13px] font-semibold text-slate-700">Work email</label>
            <input
              id="login-email"
              required
              type="email"
              maxLength={254}
              autoComplete="username"
              className="h-[52px] w-full rounded-xl border-[1.5px] border-slate-200 bg-white px-4 text-base text-slate-900 outline-none transition-all focus:border-indigo-600 focus:ring-4 focus:ring-indigo-50"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="name@nxtwave.in"
            />
          </div>

          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <label htmlFor="login-password" className="block text-[13px] font-semibold text-slate-700">Password</label>
              <button
                type="button"
                onClick={() => setShowForgot(true)}
                className="text-[13px] font-semibold text-indigo-600 hover:text-indigo-700 hover:underline"
              >
                Forgot?
              </button>
            </div>
            <PasswordInput
              id="login-password"
              required
              maxLength={128}
              autoComplete="current-password"
              className="h-[52px] w-full rounded-xl border-[1.5px] border-slate-200 bg-white px-4 text-base text-slate-900 outline-none transition-all focus:border-indigo-600 focus:ring-4 focus:ring-indigo-50"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Your password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 text-base font-bold text-white shadow-[0_8px_16px_-6px_rgba(79,70,229,0.5)] transition-colors hover:bg-indigo-700 disabled:opacity-70"
          >
            {loading ? 'Signing in…' : 'Sign in'}
            {!loading && <ArrowRight size={18} aria-hidden="true" />}
          </button>
        </form>

        <GoogleSignInButton
          onLogin={onLogin}
          onError={reportSignInError}
          disabled={loading}
        />
      </div>

      <ForgotPasswordDialog
        open={showForgot}
        initialEmail={username}
        onClose={() => setShowForgot(false)}
      />
    </main>
  );
}
