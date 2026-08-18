import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { markNativeShell } from './lib/platform';
import './index.css';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root was not found in the document.');

// Applied before first paint so the app never flashes an unpadded frame
// under the status bar.
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
