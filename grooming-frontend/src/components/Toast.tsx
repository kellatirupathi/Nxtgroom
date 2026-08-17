import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import {
  ToastContext,
  type Toast,
  type ToastApi,
  type ToastKind,
  type ToastOptions,
} from './toastContext';

/** Errors stay up longer because they usually require the user to act. */
const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 3500,
  info: 4000,
  warning: 6000,
  error: 7000,
};

const STYLES: Record<ToastKind, { icon: typeof Info; ring: string; iconColor: string }> = {
  success: { icon: CheckCircle2, ring: 'ring-emerald-200', iconColor: 'text-emerald-600' },
  error: { icon: XCircle, ring: 'ring-rose-200', iconColor: 'text-rose-600' },
  warning: { icon: AlertTriangle, ring: 'ring-amber-200', iconColor: 'text-amber-600' },
  info: { icon: Info, ring: 'ring-indigo-200', iconColor: 'text-indigo-600' },
};

/** Keeps the stack from covering the screen if something loops. */
const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (kind: ToastKind, title: string, options: ToastOptions = {}) => {
      if (!title) return;
      const id = nextId.current++;
      const toast: Toast = { id, kind, title, detail: options.detail };

      setToasts((current) => {
        // Collapse an identical message already on screen instead of stacking
        // duplicates when a user retries the same failing action.
        const duplicate = current.find(
          (item) => item.title === title && item.detail === options.detail && item.kind === kind,
        );
        if (duplicate) return current;
        return [...current, toast].slice(-MAX_VISIBLE);
      });

      const duration = options.durationMs ?? DEFAULT_DURATION[kind];
      if (duration > 0) {
        timers.current.set(id, setTimeout(() => dismiss(id), duration));
      }
    },
    [dismiss],
  );

  // Clear pending timers if the provider unmounts mid-countdown.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      notify,
      dismiss,
      success: (title, options) => notify('success', title, options),
      error: (title, options) => notify('error', title, options),
      info: (title, options) => notify('info', title, options),
      warning: (title, options) => notify('warning', title, options),
    }),
    [notify, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div
      // Top-centre on phones/tablets where there is no room beside content, and
      // top-right on desktop. pointer-events-none lets clicks reach the page
      // behind the empty part of the column.
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 p-3 sm:inset-x-auto sm:right-0 sm:items-end sm:p-4"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((toast) => {
        const { icon: Icon, ring, iconColor } = STYLES[toast.kind];
        return (
          <div
            key={toast.id}
            role={toast.kind === 'error' ? 'alert' : 'status'}
            aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
            className={`pointer-events-auto w-full max-w-sm rounded-md border border-slate-200 bg-white p-3 shadow-lg ring-1 ${ring} animate-in fade-in slide-in-from-top-2 duration-200`}
          >
            <div className="flex items-start gap-3">
              <Icon size={18} className={`mt-0.5 shrink-0 ${iconColor}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-800">{toast.title}</p>
                {toast.detail && <p className="mt-0.5 text-xs text-slate-500">{toast.detail}</p>}
              </div>
              <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                aria-label="Dismiss notification"
                className="-m-1 shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
