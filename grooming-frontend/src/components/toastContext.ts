import { createContext } from 'react';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

export interface ToastOptions {
  detail?: string;
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
