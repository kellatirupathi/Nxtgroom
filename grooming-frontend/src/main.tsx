import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { markNativeShell } from './lib/platform';
import './index.css';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import { publicFormFromLocation } from './routes';
import { prefetchPublicForm } from './lib/formPrefetch';

// An institute's form link: ask for its data and code at once, before the app
// has even drawn, so the form appears as soon as possible.
const formRoute = publicFormFromLocation();
if (formRoute) {
  prefetchPublicForm(formRoute.token, formRoute.date);
  void import('./components/PublicFormPage').catch(() => { });
}

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
