import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { markNativeShell } from './lib/platform';
import './index.css';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root was not found in the document.');

markNativeShell();

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
);
