import { useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, User } from 'lucide-react';
import { apiJson } from '../api';
import type { Role } from '../types';

interface ModalShellProps {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  children: ReactNode;
  labelledBy: string;
}

interface ProfileModalProps {
  email: string | null;
  role: Role | null;
  collegeId: string | null;
  onClose: () => void;
}

interface ChangePasswordModalProps {
  onClose: () => void;
  onPasswordChanged: () => void;
  /** Opens the email-a-reset-link flow for users who forgot their password. */
  onForgotPassword: () => void;
}

function roleLabel(role: Role | null) {
  if (role === 'SUPER_ADMIN') return 'Super Admin';
  if (role === 'BOA') return 'Board of Administration';
  return role || 'Unknown';
}

function ModalShell({ title, icon, onClose, children, labelledBy }: ModalShellProps) {
  return (
    <div
      className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
    >
      <div className="bg-white rounded-md shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-slate-200 flex justify-between items-center">
          <h2 id={labelledBy} className="text-lg font-bold text-slate-800 flex items-center gap-2">
            {icon}
            {title}
          </h2>
          <button
            type="button"
            aria-label={`Close ${title.toLowerCase()} dialog`}
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 border border-slate-200 px-2 py-1 rounded-md"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ProfileModal({ email, role, collegeId, onClose }: ProfileModalProps) {
  return (
    <ModalShell
      title="Profile"
      labelledBy="profile-dialog-title"
      icon={<User size={18} className="text-indigo-600" aria-hidden="true" />}
      onClose={onClose}
    >
      <div className="p-5 space-y-4">
        <div>
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Email</div>
          <div className="text-sm font-medium text-slate-800 mt-1 break-all">{email || '--'}</div>
        </div>
        <div>
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Role</div>
          <div className="text-sm font-medium text-slate-800 mt-1">{roleLabel(role)}</div>
        </div>
        {collegeId && (
          <div>
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">College ID</div>
            <div className="text-xs font-mono text-slate-600 mt-1 break-all">{collegeId}</div>
          </div>
        )}
        <div className="pt-2">
          <button
            type="button"
            onClick={onClose}
            className="w-full px-4 py-2.5 rounded-md font-semibold text-sm text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function ChangePasswordModal({ onClose, onPasswordChanged, onForgotPassword }: ChangePasswordModalProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await apiJson('/api/v2/auth/change-password', {
        method: 'POST',
        body: { current_password: currentPassword, new_password: newPassword },
      });
      // The server bumps session_version, so every existing token — including
      // this one — is now invalid. Sign out rather than leave a dead session.
      onPasswordChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
      setSubmitting(false);
    }
  };

  const inputClass =
    'w-full rounded-md border border-slate-300 p-2.5 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all';

  return (
    <ModalShell
      title="Change Password"
      labelledBy="password-dialog-title"
      icon={<KeyRound size={18} className="text-indigo-600" aria-hidden="true" />}
      onClose={submitting ? () => {} : onClose}
    >
      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        {error && (
          <div role="alert" className="border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700 rounded-md">
            {error}
          </div>
        )}
        <div>
          <label htmlFor="current-password" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">
            Current password
          </label>
          <input
            id="current-password"
            type="password"
            required
            autoComplete="current-password"
            className={inputClass}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="new-password" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">
            New password
          </label>
          <input
            id="new-password"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            className={inputClass}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <p className="text-xs text-slate-500 mt-1">Minimum 12 characters.</p>
        </div>
        <div>
          <label htmlFor="confirm-password" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">
            Confirm new password
          </label>
          <input
            id="confirm-password"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            className={inputClass}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </div>
        <p className="text-xs text-slate-500">
          Changing your password signs you out of all devices, including this one.
        </p>
        {/* An escape hatch for someone who is signed in on a remembered
            session but no longer knows the current password. */}
        <button
          type="button"
          onClick={onForgotPassword}
          disabled={submitting}
          className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 hover:underline disabled:opacity-50"
        >
          Forgot your current password? Email yourself a reset link.
        </button>
        <div className="pt-1 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex-1 px-4 py-2.5 rounded-md font-semibold text-sm text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="flex-1 px-4 py-2.5 rounded-md font-semibold text-sm text-white bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Change Password'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
