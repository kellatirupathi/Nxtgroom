import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import BottomNav from './components/BottomNav';
import Login from './components/Login';
import ResetPassword from './components/ResetPassword';
import BrandedLoader from './components/BrandedLoader';
import {
  currentTabFromLocation,
  homeTabForRole,
  dailyReportFromLocation,
  publicReportFromLocation,
  pushTabPath,
  recordIdFromLocation,
  replaceTabPath,
  RESET_PASSWORD_PATH,
  type DailyReportRoute,
  type PublicReportRoute,
} from './routes';
import { ChangePasswordModal, ProfileModal } from './components/AccountModals';
import ForgotPasswordDialog from './components/ForgotPasswordDialog';
import {
  apiFetch,
  apiJson,
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
import type { SettingsTab } from './components/SettingsPage';

const Dashboard = lazy(() => import('./components/Dashboard'));
const InstituteAnalytics = lazy(() => import('./components/InstituteAnalytics'));
const EvaluateCard = lazy(() => import('./components/EvaluateCard'));
const InstructorDetail = lazy(() => import('./components/InstructorDetail'));
const PublicReportPage = lazy(() => import('./components/PublicReportPage'));
const DailyReportPage = lazy(() => import('./components/DailyReportPage'));
const DailyAttendanceTable = lazy(() => import('./components/DailyAttendanceTable'));
const UserManagement = lazy(() => import('./components/UserManagement'));
const SettingsPage = lazy(() => import('./components/SettingsPage'));
const InstructorManagement = lazy(() => import('./components/InstructorManagement'));
const AttendanceScreen = lazy(() => import('./components/AttendanceScreen'));
const EscalationsPage = lazy(() => import('./components/EscalationsPage'));

interface SessionState {
  token: string | null;
  role: Role | null;
  email: string | null;
  collegeId: string | null;
  validated: boolean;
  canDeleteRecords?: boolean;
  canReanalyse?: boolean;
  faceIdentification?: boolean;
  canDeleteCheckout?: boolean;
}

type AccountModal = 'profile' | 'password' | 'forgot' | null;

const ADMIN_TABS = new Set(['dashboard', 'institutes', 'boa-management', 'settings', 'instructor-management', 'escalations']);
const INSTRUCTORS_PATH = '/api/v2/instructors?include_feedback=false';

function initialSession(): SessionState {
  try {
    localStorage.removeItem('nxtwave_token');
    localStorage.removeItem('nxtwave_role');
  } catch { }
  const token = getSessionToken();
  return { token, role: token ? getSessionRole() : null, email: null, collegeId: null, validated: !token };
}

function initialResetToken(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    if (window.location.pathname !== RESET_PASSWORD_PATH) return null;
    const token = new URLSearchParams(window.location.search).get('token');
    return token && token.length <= 512 ? token : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [publicReport] = useState<PublicReportRoute | null>(publicReportFromLocation);
  const [dailyReport] = useState<DailyReportRoute | null>(dailyReportFromLocation);
  const [session, setSession] = useState(initialSession);
  const [resetToken, setResetToken] = useState<string | null>(initialResetToken);
  const [activeTab, setActiveTab] = useState<string>(currentTabFromLocation);
  const [instructors, setInstructors] = useState<Instructor[]>(() => {
    const cached = readStale<Instructor[]>(INSTRUCTORS_PATH);
    return Array.isArray(cached) ? cached : [];
  });
  const [selectedAttendanceRecord, setSelectedAttendanceRecord] = useState<AttendanceRecord | null>(null);
  const [loadError, setLoadError] = useState('');
  const [sessionCheckError, setSessionCheckError] = useState('');
  const [sessionCheckAttempt, setSessionCheckAttempt] = useState(0);
  const [accountModal, setAccountModal] = useState<AccountModal>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('notifications');

  const handleLogin = (token: string, role: Role) => {
    setSession({ token, role, email: null, collegeId: null, validated: false });
    setSessionCheckError('');
    const home = homeTabForRole(isElevatedRole(role));
    setActiveTab(home);
    replaceTabPath(home);
  };

  const handleLogout = useCallback(() => {
    void apiJson('/api/v2/auth/logout', { method: 'POST', auth: false }).catch(() => {});
    clearSession();
    setSession({ token: null, role: null, email: null, collegeId: null, validated: true });
    setInstructors([]);
    setSelectedAttendanceRecord(null);
    setActiveTab('overview');
    replaceTabPath('overview');
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
        setSession({ token: session.token, role: currentUser.role, email: currentUser.email || null, collegeId: currentUser.college_id || null, validated: true, canDeleteRecords: Boolean(currentUser.can_delete_records), canDeleteCheckout: Boolean(currentUser.can_delete_checkout), canReanalyse: Boolean(currentUser.reanalyse_enabled), faceIdentification: Boolean(currentUser.face_identification) });
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
      const data = await apiFetchAllPages<Instructor>(INSTRUCTORS_PATH, {
        pageSize: 1_000,
        cacheMs: 15_000,
        signal,
      });
      if (signal?.aborted) return;
      if (Array.isArray(data)) primeCache(INSTRUCTORS_PATH, data);
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

  const navigate = useCallback((tab: string, { replace = false } = {}) => {
    if (tab === 'settings') setSettingsTab('notifications');
    let target = tab;
    if (ADMIN_TABS.has(tab) && !isElevatedRole(session.role)) target = 'overview';
    else if (tab === 'instructor-detail' && !selectedAttendanceRecord) target = 'daily-records';

    setActiveTab(target);
    if (replace || target !== tab) replaceTabPath(target);
    else pushTabPath(target);
  }, [session.role, selectedAttendanceRecord]);

  useEffect(() => {
    if (publicReport || dailyReport || resetToken) return undefined;
    if (!session.token || !session.validated) return undefined;
    const recordId = recordIdFromLocation();
    if (!recordId || selectedAttendanceRecord) return undefined;

    const controller = new AbortController();
    apiFetch<AttendanceRecord>(`/api/v2/attendance/${encodeURIComponent(recordId)}`, {
      signal: controller.signal,
    })
      .then((record) => {
        if (!controller.signal.aborted) setSelectedAttendanceRecord(record);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setActiveTab('daily-records');
        replaceTabPath('daily-records');
      });
    return () => controller.abort();
  }, [session.token, session.validated, selectedAttendanceRecord, publicReport, dailyReport, resetToken]);

  useEffect(() => {
    if (publicReport || dailyReport || resetToken) return undefined;
    const onPopState = () => {
      const tab = currentTabFromLocation();
      setActiveTab(
        (ADMIN_TABS.has(tab) && !isElevatedRole(session.role))
          ? 'overview'
          : tab,
      );
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [session.role, publicReport, dailyReport, resetToken]);

  useEffect(() => {
    if (publicReport || dailyReport || resetToken) return;
    if (!session.validated || !session.token) return;
    const atRoot = (window.location.pathname.replace(/\/+$/, '') || '/') === '/';
    const requested = atRoot ? homeTabForRole(isElevatedRole(session.role)) : currentTabFromLocation();
    const tab = requested;
    const allowed = (ADMIN_TABS.has(tab) && !isElevatedRole(session.role))
      ? 'overview'
      : tab;
    setActiveTab(allowed);
    replaceTabPath(allowed, recordIdFromLocation() || undefined);
  }, [session.validated, session.token, session.role, publicReport, dailyReport, resetToken]);

  if (publicReport) {
    return (
      <Suspense fallback={<BrandedLoader label="Loading report" />}>
        <PublicReportPage
          token={publicReport.token}
          kind={publicReport.kind}
          date={publicReport.date}
          half={publicReport.half}
        />
      </Suspense>
    );
  }

  if (dailyReport) {
    return (
      <Suspense fallback={<BrandedLoader label="Loading report" />}>
        <DailyReportPage date={dailyReport.date} token={dailyReport.token} />
      </Suspense>
    );
  }

  if (resetToken) {
    return (
      <ResetPassword
        token={resetToken}
        onDone={() => {
          window.history.replaceState(null, '', '/');
          setResetToken(null);
          handleLogout();
        }}
      />
    );
  }

  if (!session.token) {
    return <Login onLogin={handleLogin} />;
  }

  if (!session.validated) {
    if (sessionCheckError) {
      return (
        <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="rounded-md border border-slate-200 bg-white p-8 text-center shadow-sm max-w-md">
            <h1 className="text-lg font-extrabold text-slate-800">Could not verify your session</h1>
            <p role="alert" className="mt-2 text-sm text-rose-600">{sessionCheckError}</p>
            <div className="mt-5 flex justify-center gap-3">
              <button type="button" onClick={handleLogout} className="rounded-md bg-slate-100 px-4 py-2 text-sm font-bold text-slate-600">Sign out</button>
              <button type="button" onClick={() => setSessionCheckAttempt((value) => value + 1)} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-bold text-white">Retry</button>
            </div>
          </div>
        </main>
      );
    }
    return <BrandedLoader label="Verifying your session" />;
  }

  return (
    <div className="flex h-[calc(100dvh-var(--shell-offset-top))] bg-[#f8f9fc] font-sans text-gray-800 overflow-hidden relative w-full">
      <Sidebar
        activeTab={activeTab}
        navigate={navigate}
        role={session.role}
        email={session.email}
        onLogout={handleLogout}
        onOpenProfile={() => setAccountModal('profile')}
        onOpenChangePassword={() => setAccountModal('password')}
      />

      <div className="flex flex-1 flex-col min-w-0 min-h-0">
      <main className="flex-1 min-h-0 overflow-auto overscroll-contain p-4 md:p-6 pb-6 flex flex-col w-full">
        {loadError && (
          <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
            {loadError}
          </div>
        )}

        <div className="flex flex-col xl:flex-row gap-6 items-start flex-1 min-h-0 w-full">
          <Suspense fallback={<div className="w-full"><BrandedLoader label="Loading screen" /></div>}>
          {activeTab === 'dashboard' && isElevatedRole(session.role) && (
            <div className="w-full h-full">
              <Dashboard onNavigate={navigate} />
            </div>
          )}

          {activeTab === 'escalations' && isElevatedRole(session.role) && (
            <div className="w-full h-full"><EscalationsPage onBack={() => navigate('dashboard')} /></div>
          )}

          {activeTab === 'institutes' && isElevatedRole(session.role) && (
            <div className="w-full h-full"><InstituteAnalytics /></div>
          )}

          {activeTab === 'overview' && session.faceIdentification && (
            <div className="w-full h-full">
              <AttendanceScreen onExit={() => navigate('daily-records')} />
            </div>
          )}

          {activeTab === 'overview' && !session.faceIdentification && (
            <div className="w-full h-full flex justify-center items-start pt-0 md:pt-10">
              <div className="w-full max-w-2xl shrink-0">
                <EvaluateCard
                  instructors={instructors}
                  fetchInstructors={fetchInstructors}
                  faceIdentification={session.faceIdentification}
                  onInstructorGenderSaved={(instructorId, gender) => {
                    setInstructors((current) => current.map((instructor) => (
                      instructor._id === instructorId ? { ...instructor, gender } : instructor
                    )));
                  }}
                />
              </div>
            </div>
          )}

          {activeTab === 'daily-records' && (
            <div className="w-full h-full">
              <DailyAttendanceTable
                canBulkDelete={isElevatedRole(session.role)}
                onRowClick={(record) => {
                  setSelectedAttendanceRecord(record);
                  pushTabPath('instructor-detail', String(record._id));
                  setActiveTab('instructor-detail');
                }}
              />
            </div>
          )}

          {activeTab === 'instructor-detail' && (
            <div className="w-full h-full">
              <InstructorDetail
                record={selectedAttendanceRecord}
                canDelete={session.canDeleteRecords}
                canDeleteCheckout={session.canDeleteCheckout}
                canReanalyse={session.canReanalyse}
                onDeleted={() => setSelectedAttendanceRecord(null)}
                onBack={() => navigate('daily-records')}
              />
            </div>
          )}

          {activeTab === 'boa-management' && isElevatedRole(session.role) && (
            <div className="w-full h-full"><UserManagement currentRole={session.role} currentEmail={session.email} /></div>
          )}

          {activeTab === 'settings' && isElevatedRole(session.role) && (
            <div className="w-full h-full"><SettingsPage key={settingsTab} initialTab={settingsTab} /></div>
          )}

          {activeTab === 'instructor-management' && isElevatedRole(session.role) && (
            <div className="w-full h-full"><InstructorManagement /></div>
          )}
          </Suspense>
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
      </div>

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
          onForgotPassword={() => setAccountModal('forgot')}
        />
      )}

      {accountModal === 'forgot' && (
        <ForgotPasswordDialog
          open
          initialEmail={session.email || ''}
          onClose={() => setAccountModal(null)}
        />
      )}
    </div>
  );
}
