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

  /**
   * A rejected Google account is the one failure the user cannot fix by
   * retrying, so it gets an explicit next step rather than the raw message.
   */
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
    <main className="min-h-[100svh] flex items-center justify-center bg-[#f8f9fc] p-4 overflow-hidden">
      <div className="bg-white p-6 sm:p-8 md:p-10 rounded-md shadow-xl w-full max-w-md border border-slate-100 max-h-[100svh] overflow-y-auto">
        <div className="flex flex-col items-center mb-5 sm:mb-8">
          <div className="w-12 h-12 sm:w-16 sm:h-16 mb-3 sm:mb-4 flex items-center justify-center">
            <img src="/logo.png" alt="FacultyTrack" className="w-full h-full object-contain drop-shadow-sm" />
          </div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-slate-800">FacultyTrack</h1>
          <p className="text-sm font-medium text-slate-400 mt-1 uppercase tracking-widest">Management Suite</p>
        </div>

        {error && (
          <div role="alert" className="mb-4 p-3 bg-red-50 text-red-600 border border-red-100 rounded-md text-sm font-medium text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="login-email" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Email</label>
            <input
              id="login-email"
              required
              type="email"
              maxLength={254}
              autoComplete="username"
              className="w-full rounded-md border border-slate-200 p-2.5 sm:p-3 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none text-sm transition-all"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="admin@nxtwave.com"
            />
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <label htmlFor="login-password" className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Password</label>
              <button
                type="button"
                onClick={() => setShowForgot(true)}
                className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 hover:underline"
              >
                Forgot password?
              </button>
            </div>
            <PasswordInput
              id="login-password"
              required
              maxLength={128}
              autoComplete="current-password"
              className="w-full rounded-md border border-slate-200 p-3 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none text-sm transition-all"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#8b5cf6] text-white py-3 rounded-md font-bold text-sm uppercase tracking-wider flex items-center justify-center gap-2 hover:bg-[#7c3aed] transition-colors shadow-md shadow-indigo-200 disabled:opacity-70 mt-4"
          >
            {loading ? 'Authenticating…' : 'Sign In'}
            {!loading && <ArrowRight size={18} aria-hidden="true" />}
          </button>
        </form>

        {/* Renders nothing unless the server reports Google sign-in is configured. */}
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
