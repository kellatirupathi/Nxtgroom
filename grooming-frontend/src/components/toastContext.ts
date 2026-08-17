import { createContext } from 'react';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  /** Optional second line explaining what to do about it. */
  detail?: string;
}

export interface ToastOptions {
  detail?: string;
  /** Override the default lifetime; 0 keeps it until dismissed. */
  durationMs?: number;
}

export interface ToastApi {
  notify: (kind: ToastKind, title: string, options?: ToastOptions) => void;
  success: (title: string, options?: ToastOptions) => void;
  error: (title: string, options?: ToastOptions) => void;
  info: (title: string, options?: ToastOptions) => void;
  warning: (title: string, options?: ToastOptions) => void;
  dismiss: (id: number) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);
