import { useEffect, useRef, useState } from 'react';
import { apiFetch, apiJson, saveSession } from '../api';
import type { LoginResponse, Role } from '../types';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

interface GoogleConfig {
  enabled: boolean;
  client_id: string | null;
}

interface GoogleCredentialResponse {
  credential?: string;
}

/** Minimal surface of the Google Identity Services global we rely on. */
interface GoogleIdentityServices {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string;
        callback: (response: GoogleCredentialResponse) => void;
        auto_select?: boolean;
        cancel_on_tap_outside?: boolean;
        ux_mode?: 'popup' | 'redirect';
      }) => void;
      renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentityServices;
  }
}

let scriptPromise: Promise<void> | null = null;

/** Loads the Google Identity script once, shared across mounts. */
function loadGoogleScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('load failed')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Google sign-in could not be loaded.'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

interface GoogleSignInButtonProps {
  onLogin: (token: string, role: Role) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}

export default function GoogleSignInButton({ onLogin, onError, disabled }: GoogleSignInButtonProps) {
  const [config, setConfig] = useState<GoogleConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest callbacks reachable from Google's callback without
  // re-initialising the button on every parent render.
  const handlersRef = useRef({ onLogin, onError });
  handlersRef.current = { onLogin, onError };

  // The server decides whether Google sign-in is available, so the button
  // never renders against a missing or stale client id.
  useEffect(() => {
    let disposed = false;
    apiFetch<GoogleConfig>('/api/v2/auth/google/config', { auth: false })
      .then((data) => {
        if (!disposed) setConfig(data);
      })
      .catch(() => {
        if (!disposed) setConfig({ enabled: false, client_id: null });
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!config?.enabled || !config.client_id || !containerRef.current) return;
    let disposed = false;

    const handleCredential = async (response: GoogleCredentialResponse) => {
      if (!response?.credential) {
        handlersRef.current.onError('Google did not return a credential. Please try again.');
        return;
      }
      setBusy(true);
      try {
        // On phones the Google prompt takes over the tab, and returning can
        // drop a connection opened while the page was hidden. The credential
        // is still valid, so retry rather than making the user start over.
        let data: LoginResponse | undefined;
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            data = await apiJson<LoginResponse>('/api/v2/auth/google', {
              method: 'POST',
              auth: false,
              body: { credential: response.credential },
            });
            break;
          } catch (attemptError) {
            lastError = attemptError;
            // A rejected account or expired credential will fail identically
            // every time; only retry transport-level failures.
            const status = (attemptError as { status?: number })?.status;
            if (status !== undefined) throw attemptError;
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          }
        }
        if (!data) throw lastError ?? new Error('Google sign-in could not be completed.');
        if (!data?.access_token || !['SUPER_ADMIN', 'ADMIN', 'BOA'].includes(data.role)) {
          throw new Error('The server returned an invalid login response.');
        }
        saveSession(data.access_token, data.role);
        handlersRef.current.onLogin(data.access_token, data.role);
      } catch (requestError) {
        handlersRef.current.onError(
          requestError instanceof Error ? requestError.message : String(requestError),
        );
      } finally {
        if (!disposed) setBusy(false);
      }
    };

    loadGoogleScript()
      .then(() => {
        if (disposed || !containerRef.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: config.client_id as string,
          callback: handleCredential,
          auto_select: false,
          cancel_on_tap_outside: true,
          ux_mode: 'popup',
        });
        containerRef.current.replaceChildren();
        window.google.accounts.id.renderButton(containerRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'center',
          width: 320,
        });
        setReady(true);
      })
      .catch(() => {
        if (!disposed) handlersRef.current.onError('Google sign-in could not be loaded.');
      });

    return () => {
      disposed = true;
    };
  }, [config]);

  if (!config?.enabled) return null;

  return (
    <div className="mt-4 sm:mt-6">
      <div className="flex items-center gap-3 mb-3 sm:mb-4">
        <span className="h-px flex-1 bg-slate-200" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">or</span>
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      <div
        className={`flex justify-center min-h-[44px] ${disabled || busy ? 'pointer-events-none opacity-60' : ''}`}
      >
        <div ref={containerRef} />
        {!ready && (
          <span className="text-sm font-medium text-slate-400" role="status">
            Loading Google sign-in…
          </span>
        )}
      </div>

      <p className="mt-3 text-center text-xs text-slate-400">
        Sign-in only. Your Google account must already be registered by an administrator.
      </p>
    </div>
  );
}
