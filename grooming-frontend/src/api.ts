import { API_BASE } from './config.ts';
import type { ApiRequestOptions, PaginatedOptions, Role } from './types.ts';

export const SESSION_EXPIRED_EVENT = 'facultytrack:session-expired';
export const SESSION_TOKEN_KEY = 'facultytrack_token';
export const SESSION_ROLE_KEY = 'facultytrack_role';
const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_PAGINATED_ITEMS = 50_000;
const MAX_PAGE_SIZE = 1_000;
const ROLES: readonly Role[] = ['SUPER_ADMIN', 'ADMIN', 'BOA'];
const COOKIE_SESSION_MARKER = 'cookie-session';

export interface ApiErrorInit {
  status?: number;
  details?: unknown;
  cause?: unknown;
}

export class ApiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, { status = 0, details = null, cause }: ApiErrorInit = {}) {
    super(message, { cause });
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

function messageFromValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(messageFromValue).filter(Boolean).join('; ');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const location = Array.isArray(record.loc) ? `${record.loc.join('.')}: ` : '';
    const message = messageFromValue(record.msg || record.message || record.detail);
    return message ? `${location}${message}` : '';
  }
  return '';
}

export function normalizeApiError(payload: unknown, fallback = 'Request failed'): string {
  const record = (payload ?? {}) as Record<string, unknown>;
  return (
    messageFromValue(record.detail) ||
    messageFromValue(record.message) ||
    messageFromValue(record.errors) ||
    messageFromValue(payload) ||
    fallback
  );
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function notifySessionExpired(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  }
}

function readStorage(key: string): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const value = localStorage.getItem(key);
      if (value !== null) return value;
    }
    return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

export function getSessionToken(): string | null {
  return readStorage(SESSION_TOKEN_KEY);
}

export function getSessionRole(): Role | null {
  const role = readStorage(SESSION_ROLE_KEY);
  return ROLES.includes(role as Role) ? (role as Role) : null;
}

export function saveSession(token: string, role: string): void {
  try {
    if (typeof localStorage === 'undefined') throw new Error('Local storage is unavailable');
    localStorage.setItem(SESSION_TOKEN_KEY, token);
    localStorage.setItem(SESSION_ROLE_KEY, role);
  } catch (error) {
    throw new ApiError(
      'Your browser is blocking site storage. Allow storage for this site and try again.',
      { cause: error },
    );
  }
}

export function clearSession(): void {
  clearRequestCache();
  for (const storage of ['localStorage', 'sessionStorage'] as const) {
    try {
      const store = globalThis[storage];
      if (!store) continue;
      store.removeItem(SESSION_TOKEN_KEY);
      store.removeItem(SESSION_ROLE_KEY);
      store.removeItem('nxtwave_token');
      store.removeItem('nxtwave_role');
    } catch { }
  }
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();
const DEFAULT_CACHE_MS = 15_000;

const PERSIST_PREFIX = 'ft_cache:';
const PERSIST_MAX_AGE_MS = 10 * 60_000;

function persistKey(path: string): string {
  return `${PERSIST_PREFIX}${path}`;
}

function persistCache(path: string, value: unknown): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(persistKey(path), JSON.stringify({ value, storedAt: Date.now() }));
  } catch {
  }
}

function readPersisted<T>(path: string): T | undefined {
  try {
    if (typeof sessionStorage === 'undefined') return undefined;
    const raw = sessionStorage.getItem(persistKey(path));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { value: T; storedAt: number };
    if (!parsed || typeof parsed.storedAt !== 'number') return undefined;
    if (Date.now() - parsed.storedAt > PERSIST_MAX_AGE_MS) {
      sessionStorage.removeItem(persistKey(path));
      return undefined;
    }
    return parsed.value;
  } catch {
    return undefined;
  }
}

function dropPersisted(prefix: string): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const target = persistKey(prefix);
    const doomed: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key && key.startsWith(PERSIST_PREFIX) && key.startsWith(target)) doomed.push(key);
    }
    for (const key of doomed) sessionStorage.removeItem(key);
  } catch {
  }
}

export function clearRequestCache(): void {
  responseCache.clear();
  inFlight.clear();
  dropPersisted('');
}

export function invalidateCache(prefix: string): void {
  for (const key of [...responseCache.keys()]) {
    if (key.startsWith(prefix)) responseCache.delete(key);
  }
  dropPersisted(prefix);
}

export function readStale<T>(path: string): T | undefined {
  const entry = responseCache.get(path);
  if (entry) return entry.value as T;
  return readPersisted<T>(path);
}

export function primeCache(path: string, value: unknown, cacheMs = DEFAULT_CACHE_MS): void {
  responseCache.set(path, { value, expiresAt: Date.now() + cacheMs });
  persistCache(path, value);
}

export function readCache<T>(path: string): T | undefined {
  const entry = responseCache.get(path);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    responseCache.delete(path);
    return undefined;
  }
  return entry.value as T;
}

export async function apiFetch<T = unknown>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const {
    auth = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers: suppliedHeaders,
    signal: suppliedSignal,
    body,
    ...requestOptions
  } = options as ApiRequestOptions & { auth?: boolean; timeoutMs?: number };
  const headers = new Headers(suppliedHeaders as HeadersInit | undefined);

  if (auth) {
    const token = getSessionToken();
    if (!token) {
      notifySessionExpired();
      throw new ApiError('Your session has expired. Please sign in again.', { status: 401 });
    }
    if (token !== COOKIE_SESSION_MARKER) headers.set('Authorization', `Bearer ${token}`);
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + timeoutMs;
  const armTimeout = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      controller.abort(new Error('Request timed out'));
      return;
    }
    timeout = setTimeout(armTimeout, Math.min(remaining, 1000));
  };
  armTimeout();
  const abortFromCaller = () => controller.abort(suppliedSignal?.reason);
  if (suppliedSignal?.aborted) abortFromCaller();
  else suppliedSignal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...requestOptions,
      credentials: 'include',
      headers,
      body: body as BodyInit | null | undefined,
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

    return payload as T;
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

export async function apiFetchCached<T = unknown>(
  path: string,
  options: ApiRequestOptions & { cacheMs?: number } = {},
): Promise<T> {
  const { cacheMs = DEFAULT_CACHE_MS, ...requestOptions } = options;
  const cached = readCache<T>(path);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(path);
  if (pending) return pending as Promise<T>;

  const request = apiFetch<T>(path, requestOptions)
    .then((value) => {
      responseCache.set(path, { value, expiresAt: Date.now() + cacheMs });
      persistCache(path, value);
      return value;
    })
    .finally(() => {
      inFlight.delete(path);
    });

  inFlight.set(path, request);
  return request;
}

export function apiJson<T = unknown>(
  path: string,
  { body, headers, ...options }: ApiRequestOptions = {},
): Promise<T> {
  return apiFetch<T>(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(headers as Record<string, string>) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function paginatedPath(path: string, limit: number, offset: number): string {
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : path.slice(queryIndex + 1));
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return `${pathname}?${params.toString()}`;
}

export async function apiFetchAllPages<T = unknown>(
  path: string,
  options: PaginatedOptions & { idKey?: string } = {},
): Promise<T[]> {
  const {
    pageSize = 100,
    maxItems = MAX_PAGINATED_ITEMS,
    idKey = '_id',
    cacheMs,
    signal,
    ...requestOptions
  } = options;

  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new TypeError(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  }
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new TypeError('maxItems must be a positive integer.');
  }

  const items: T[] = [];
  const seenIds = new Set<string>();
  let offset = 0;

  for (;;) {
    const pagePath = paginatedPath(path, pageSize, offset);
    const page = cacheMs === undefined
      ? await apiFetch<unknown>(pagePath, { ...requestOptions, signal })
      : await apiFetchCached<unknown>(pagePath, { ...requestOptions, signal, cacheMs });
    if (!Array.isArray(page)) {
      throw new ApiError('The server returned an invalid paginated response. Please try again.');
    }
    if (page.length > pageSize) {
      throw new ApiError('The server returned an oversized page. Please try again.');
    }

    let added = 0;
    for (const item of page) {
      const id = (item as Record<string, unknown> | null)?.[idKey];
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
      items.push(item as T);
      added += 1;
    }

    if (page.length < pageSize) return items;
    if (added === 0) {
      throw new ApiError('Pagination did not make progress. Please refresh and try again.');
    }
    offset += page.length;
  }
}
