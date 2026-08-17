import React, { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { apiFetch, saveSession } from '../api';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const formData = new URLSearchParams({ username: username.trim(), password });
      const data = await apiFetch('/api/v2/auth/login', {
        method: 'POST',
        auth: false,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData,
      });

      if (!data?.access_token || !['SUPER_ADMIN', 'BOA'].includes(data.role)) {
        throw new Error('The server returned an invalid login response.');
      }
      saveSession(data.access_token, data.role);
      onLogin(data.access_token, data.role);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#f8f9fc] p-4">
      <div className="bg-white p-8 md:p-10 rounded-md shadow-xl w-full max-w-md border border-slate-100">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 mb-4 flex items-center justify-center">
            <img src="/logo.png" alt="FacultyTrack" className="w-full h-full object-contain drop-shadow-sm" />
          </div>
          <h1 className="text-2xl font-extrabold text-slate-800">FacultyTrack</h1>
          <p className="text-sm font-medium text-slate-400 mt-1 uppercase tracking-widest">Management Suite</p>
        </div>

        {error && (
          <div role="alert" className="mb-4 p-3 bg-red-50 text-red-600 border border-red-100 rounded-md text-sm font-medium text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="login-email" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Email</label>
            <input
              id="login-email"
              required
              type="email"
              maxLength="254"
              autoComplete="username"
              className="w-full rounded-md border border-slate-200 p-3 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none text-sm transition-all"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="admin@nxtwave.com"
            />
          </div>

          <div>
            <label htmlFor="login-password" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Password</label>
            <input
              id="login-password"
              required
              type="password"
              maxLength="128"
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
            className="w-full bg-[#8b5cf6] text-white py-3.5 rounded-md font-bold text-sm uppercase tracking-wider flex items-center justify-center gap-2 hover:bg-[#7c3aed] transition-colors shadow-md shadow-indigo-200 disabled:opacity-70 mt-4"
          >
            {loading ? 'Authenticating…' : 'Sign In'}
            {!loading && <ArrowRight size={18} aria-hidden="true" />}
          </button>
        </form>
      </div>
    </main>
  );
}
