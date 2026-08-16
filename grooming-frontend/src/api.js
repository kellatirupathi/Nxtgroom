import { API_BASE } from './config.js';

export const SESSION_EXPIRED_EVENT = 'facultytrack:session-expired';
export const SESSION_TOKEN_KEY = 'facultytrack_token';
export const SESSION_ROLE_KEY = 'facultytrack_role';
const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_PAGINATED_ITEMS = 50_000;
const MAX_PAGE_SIZE = 1_000;

export class ApiError extends Error {
  constructor(message, { status = 0, details = null, cause } = {}) {
    super(message, { cause });
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

function messageFromValue(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(messageFromValue).filter(Boolean).join('; ');
  }
  if (value && typeof value === 'object') {
    const location = Array.isArray(value.loc) ? `${value.loc.join('.')}: ` : '';
    const message = messageFromValue(value.msg || value.message || value.detail);
    return message ? `${location}${message}` : '';
  }
  return '';
}

export function normalizeApiError(payload, fallback = 'Request failed') {
  return (
    messageFromValue(payload?.detail) ||
    messageFromValue(payload?.message) ||
    messageFromValue(payload?.errors) ||
    messageFromValue(payload) ||
    fallback
  );
}

async function readResponseBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function notifySessionExpired() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  }
}

export function getSessionToken() {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SESSION_TOKEN_KEY) : null;
  } catch {
    return null;
  }
}

export function getSessionRole() {
  try {
    const role = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SESSION_ROLE_KEY) : null;
    return ['SUPER_ADMIN', 'BOA'].includes(role) ? role : null;
  } catch {
    return null;
  }
}

export function saveSession(token, role) {
  try {
    if (typeof sessionStorage === 'undefined') throw new Error('Session storage is unavailable');
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    sessionStorage.setItem(SESSION_ROLE_KEY, role);
  } catch (error) {
    throw new ApiError('Your browser is blocking session storage. Allow site storage and try again.', { cause: error });
  }
}

export function clearSession() {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
      sessionStorage.removeItem(SESSION_ROLE_KEY);
    }
  } catch { /* Storage may be disabled by browser policy. */ }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('nxtwave_token');
      localStorage.removeItem('nxtwave_role');
    }
  } catch { /* Remove legacy keys when storage is available. */ }
}

export async function apiFetch(path, options = {}) {
  const {
    auth = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers: suppliedHeaders,
    signal: suppliedSignal,
    ...requestOptions
  } = options;
  const headers = new Headers(suppliedHeaders || {});

  if (auth) {
    const token = getSessionToken();
    if (!token) {
      notifySessionExpired();
      throw new ApiError('Your session has expired. Please sign in again.', { status: 401 });
    }
    headers.set('Authorization', `Bearer ${token}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  const abortFromCaller = () => controller.abort(suppliedSignal?.reason);
  if (suppliedSignal?.aborted) abortFromCaller();
  else suppliedSignal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...requestOptions,
      headers,
      signal: controller.signal,
    });
    const payload = await readResponseBody(response);

    if (!response.ok) {
      if (response.status === 401 && auth) notifySessionExpired();
      throw new ApiError(
        normalizeApiError(payload, `Request failed with status ${response.status}`),
        { status: response.status, details: payload },
      );
    }

    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError('The request timed out or was cancelled. Please try again.', { cause: error });
    }
    throw new ApiError('Unable to reach the server. Check your connection and try again.', { cause: error });
  } finally {
    clearTimeout(timeout);
    suppliedSignal?.removeEventListener('abort', abortFromCaller);
  }
}

export function apiJson(path, { body, headers, ...options } = {}) {
  return apiFetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function paginatedPath(path, limit, offset) {
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : path.slice(queryIndex + 1));
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return `${pathname}?${params.toString()}`;
}

export async function apiFetchAllPages(path, options = {}) {
  const {
    pageSize = 100,
    maxItems = MAX_PAGINATED_ITEMS,
    idKey = '_id',
    signal,
    ...requestOptions
  } = options;

  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new TypeError(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  }
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new TypeError('maxItems must be a positive integer.');
  }

  const items = [];
  const seenIds = new Set();
  let offset = 0;

  while (true) {
    const page = await apiFetch(paginatedPath(path, pageSize, offset), {
      ...requestOptions,
      signal,
    });
    if (!Array.isArray(page)) {
      throw new ApiError('The server returned an invalid paginated response. Please try again.');
    }
    if (page.length > pageSize) {
      throw new ApiError('The server returned an oversized page. Please try again.');
    }

    let added = 0;
    for (const item of page) {
      const id = item?.[idKey];
      if (id === undefined || id === null || id === '') {
        throw new ApiError(`The server returned a record without ${idKey}. Please try again.`);
      }
      const normalizedId = String(id);
      if (seenIds.has(normalizedId)) continue;
      if (items.length >= maxItems) {
        throw new ApiError(
          `The result exceeds the safety limit of ${maxItems.toLocaleString()} records. Contact support to narrow this request.`,
        );
      }
      seenIds.add(normalizedId);
      items.push(item);
      added += 1;
    }

    if (page.length < pageSize) return items;
    if (added === 0) {
      throw new ApiError('Pagination did not make progress. Please refresh and try again.');
    }
    offset += page.length;
  }
}
