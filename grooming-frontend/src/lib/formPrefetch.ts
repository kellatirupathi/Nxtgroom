// Opening an institute's form link: its data is asked for the moment the app
// starts, at the same time as the form's own code downloads, instead of after
// it. The form page then takes the answer already on its way. A copy of the
// last data is also kept in the browser, so the same link opens at once next
// time and refreshes quietly.
import { apiFetch } from '../api.ts';
import type { PublicFormData } from './instituteForm.ts';

const forms = new Map<string, Promise<PublicFormData>>();
const CACHE_PREFIX = 'ft_form:';
// Photo links in a kept copy are signed for an hour; use it well inside that.
const CACHE_MAX_AGE_MS = 45 * 60 * 1000;

export function publicFormPath(token: string, date: string | null): string {
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  return `/api/v2/forms/${encodeURIComponent(token)}${query}`;
}

function formKey(token: string, date: string | null): string {
  return `${token}|${date ?? ''}`;
}

// Starts the request for a form link, once.
export function prefetchPublicForm(token: string, date: string | null): void {
  if (date === 'invalid') return;
  const key = formKey(token, date);
  if (!forms.has(key)) {
    const request = apiFetch<PublicFormData>(publicFormPath(token, date), { auth: false });
    request.catch(() => { });
    forms.set(key, request);
  }
}

// The form data request already on its way, if any (used once).
export function takePrefetchedForm(token: string, date: string | null): Promise<PublicFormData> | null {
  const key = formKey(token, date);
  const request = forms.get(key) ?? null;
  forms.delete(key);
  return request;
}

interface CachedForm {
  savedAt: number;
  data: PublicFormData;
}

// The last data seen for this link, when it is for the date being opened
// (today's date for a link without one) and recent enough to show.
export function readCachedForm(token: string, date: string | null, today: string, now: number = Date.now()): PublicFormData | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${token}`);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedForm;
    if (!cached?.data?.institute || typeof cached.savedAt !== 'number') return null;
    if (now - cached.savedAt > CACHE_MAX_AGE_MS) return null;
    const wanted = date ?? today;
    if (cached.data.date !== wanted || cached.data.today !== today) return null;
    return cached.data;
  } catch {
    return null;
  }
}

// The institute's name and place from any earlier visit, for the header.
export function cachedInstitute(token: string): PublicFormData['institute'] | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${token}`);
    const cached = raw ? (JSON.parse(raw) as CachedForm) : null;
    return cached?.data?.institute ?? null;
  } catch {
    return null;
  }
}

export function writeCachedForm(token: string, data: PublicFormData, now: number = Date.now()): void {
  try {
    localStorage.setItem(`${CACHE_PREFIX}${token}`, JSON.stringify({ savedAt: now, data } satisfies CachedForm));
  } catch { }
}
