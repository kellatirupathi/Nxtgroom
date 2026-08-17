import { useContext } from 'react';
import { ToastContext, type ToastApi } from './toastContext';

/**
 * Lives outside Toast.tsx so that file exports only components, which is what
 * React Fast Refresh requires to hot-reload the provider cleanly.
 */
export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within a ToastProvider');
  return context;
}
