import { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import BottomNav from './components/BottomNav';
import EvaluateCard from './components/EvaluateCard';
import InstructorDetail from './components/InstructorDetail';
import Login from './components/Login';
import DailyAttendanceTable from './components/DailyAttendanceTable';
import UserManagement from './components/UserManagement';
import SettingsPage from './components/SettingsPage';
import { ChangePasswordModal, ProfileModal } from './components/AccountModals';
import InstructorManagement from './components/InstructorManagement';
import {
  apiFetch,
  apiFetchAllPages,
  clearSession,
  getSessionRole,
  getSessionToken,
  primeCache,
  readStale,
  saveSession,
  SESSION_EXPIRED_EVENT,
} from './api';
import { isElevatedRole, type AttendanceRecord, type CurrentUser, type Instructor, type Role } from './types';

interface SessionState {
  token: string | null;
  role: Role | null;
  email: string | null;
  collegeId: string | null;
  validated: boolean;
}

type AccountModal = 'profile' | 'password' | null;

const ADMIN_TABS = new Set(['boa-management', 'settings', 'instructor-management']);

function initialSession(): SessionState {
  try {
    localStorage.removeItem('nxtwave_token');
    localStorage.removeItem('nxtwave_role');
  } catch { /* Legacy storage may be blocked by browser policy. */ }
  const token = getSessionToken();
  return { token, role: token ? getSessionRole() : null, email: null, collegeId: null, validated: !token };
}

export default function App() {
  const [session, setSession] = useState(initialSession);
  const [activeTab, setActiveTab] = useState('overview');
  const [instructors, setInstructors] = useState<Instructor[]>(() => {
    // Render the attendance list from the last session's data on first paint.
    const cached = readStale<Instructor[]>('/api/v2/instructors');
    return Array.isArray(cached) ? cached : [];
  });
  const [selectedAttendanceRecord, setSelectedAttendanceRecord] = useState<AttendanceRecord | null>(null);
  const [loadError, setLoadError] = useState('');
  const [sessionCheckError, setSessionCheckError] = useState('');
  const [sessionCheckAttempt, setSessionCheckAttempt] = useState(0);
  const [accountModal, setAccountModal] = useState<AccountModal>(null);

  const handleLogin = (token: string, role: Role) => {
    setSession({ token, role, email: null, collegeId: null, validated: true });
    setSessionCheckError('');
    setActiveTab('overview');
  };

  const handleLogout = useCallback(() => {
    clearSession();
    setSession({ token: null, role: null, email: null, collegeId: null, validated: true });
    setInstructors([]);
    setSelectedAttendanceRecord(null);
    setActiveTab('overview');
  }, []);

  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED_EVENT, handleLogout);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleLogout);
  }, [handleLogout]);

  useEffect(() => {
    if (!session.token || session.validated) return undefined;
    const controller = new AbortController();
    const validateSession = async () => {
      setSessionCheckError('');
      try {
        const currentUser = await apiFetch<CurrentUser>('/api/v2/auth/me', { signal: controller.signal });
        if (!['SUPER_ADMIN', 'ADMIN', 'BOA'].includes(currentUser?.role)) {
          throw new Error('The server returned an invalid user role.');
        }
        saveSession(session.token as string, currentUser.role);
        setSession({ token: session.token, role: currentUser.role, email: currentUser.email || null, collegeId: currentUser.college_id || null, validated: true });
      } catch (error) {
        if (!controller.signal.aborted && (error as { status?: number })?.status !== 401) setSessionCheckError(error instanceof Error ? error.message : String(error));
      }
    };
    validateSession();
    return () => controller.abort();
  }, [session.token, session.validated, sessionCheckAttempt]);

  const fetchInstructors = useCallback(async ({ signal }: { signal?: AbortSignal } = {}) => {
    if (!session.token || !session.validated) return;
    try {
      const data = await apiFetchAllPages<Instructor>('/api/v2/instructors', { pageSize: 100, signal });
      if (signal?.aborted) return;
      // Cache the assembled list so the next load paints without waiting.
      if (Array.isArray(data)) primeCache('/api/v2/instructors', data);
      setInstructors(Array.isArray(data) ? data : []);
      setLoadError('');
    } catch (error) {
      if (!signal?.aborted && (error as { status?: number })?.status !== 401) setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [session.token, session.validated]);

  useEffect(() => {
    if (!session.token || !session.validated) return undefined;
    const controller = new AbortController();
    fetchInstructors({ signal: controller.signal });
    return () => controller.abort();
  }, [session.token, session.validated, fetchInstructors]);

  const navigate = (tab: string) => {
    if (ADMIN_TABS.has(tab) && !isElevatedRole(session.role)) {
      setActiveTab('overview');
      return;
    }
    if (tab === 'instructor-detail' && !selectedAttendanceRecord) {
      setActiveTab('daily-records');
      return;
    }
    setActiveTab(tab);
  };

  if (!session.token) {
    return <Login onLogin={handleLogin} />;
  }

  if (!session.validated) {
    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="rounded-md border border-slate-200 bg-white p-8 text-center shadow-sm max-w-md">
          {sessionCheckError ? (
            <>
              <h1 className="text-lg font-extrabold text-slate-800">Could not verify your session</h1>
              <p role="alert" className="mt-2 text-sm text-rose-600">{sessionCheckError}</p>
              <div className="mt-5 flex justify-center gap-3">
                <button type="button" onClick={handleLogout} className="rounded-md bg-slate-100 px-4 py-2 text-sm font-bold text-slate-600">Sign out</button>
                <button type="button" onClick={() => setSessionCheckAttempt((value) => value + 1)} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-bold text-white">Retry</button>
              </div>
            </>
          ) : (
            <div role="status" className="text-sm font-medium text-slate-500">Verifying your session…</div>
          )}
        </div>
      </main>
    );
  }

  return (
    <div className="flex h-screen bg-[#f8f9fc] font-sans text-gray-800 overflow-hidden relative w-full">
      {/* Desktop keeps the full sidebar; below lg it is hidden entirely in
          favour of the app-style bottom navigation bar. */}
      <Sidebar
        activeTab={activeTab}
        navigate={navigate}
        role={session.role}
        email={session.email}
        onLogout={handleLogout}
        onOpenProfile={() => setAccountModal('profile')}
        onOpenChangePassword={() => setAccountModal('password')}
      />

      {/* pb clears the fixed bottom bar (and the iOS home indicator) so the
          last row of any list stays reachable on touch devices. */}
      <main className="flex-1 h-full overflow-auto p-4 md:p-6 pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-6 flex flex-col w-full">
        {loadError && (
          <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
            {loadError}
          </div>
        )}

        <div className="flex flex-col xl:flex-row gap-6 items-start flex-1 min-h-0 w-full">
          {activeTab === 'overview' && (
            <div className="w-full h-full flex justify-center items-start pt-10">
              <div className="w-full max-w-2xl shrink-0">
                <EvaluateCard instructors={instructors} fetchInstructors={fetchInstructors} />
              </div>
            </div>
          )}

          {activeTab === 'daily-records' && (
            <div className="w-full h-full">
              <DailyAttendanceTable onRowClick={(record) => {
                setSelectedAttendanceRecord(record);
                setActiveTab('instructor-detail');
              }} />
            </div>
          )}

          {activeTab === 'instructor-detail' && (
            <div className="w-full h-full">
              <InstructorDetail record={selectedAttendanceRecord} onBack={() => navigate('daily-records')} />
            </div>
          )}

          {activeTab === 'boa-management' && isElevatedRole(session.role) && (
            <div className="w-full h-full"><UserManagement currentRole={session.role} currentEmail={session.email} /></div>
          )}

          {activeTab === 'settings' && isElevatedRole(session.role) && (
            <div className="w-full h-full"><SettingsPage /></div>
          )}

          {activeTab === 'instructor-management' && isElevatedRole(session.role) && (
            <div className="w-full h-full"><InstructorManagement /></div>
          )}
        </div>
      </main>

      <BottomNav
        activeTab={activeTab}
        navigate={navigate}
        role={session.role}
        email={session.email}
        onLogout={handleLogout}
        onOpenProfile={() => setAccountModal('profile')}
        onOpenChangePassword={() => setAccountModal('password')}
      />

      {accountModal === 'profile' && (
        <ProfileModal
          email={session.email}
          role={session.role}
          collegeId={session.collegeId}
          onClose={() => setAccountModal(null)}
        />
      )}

      {accountModal === 'password' && (
        <ChangePasswordModal
          onClose={() => setAccountModal(null)}
          onPasswordChanged={() => {
            setAccountModal(null);
            handleLogout();
          }}
        />
      )}
    </div>
  );
}
