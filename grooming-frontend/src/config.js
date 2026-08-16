const viteEnv = import.meta.env || {};
const isProduction = Boolean(viteEnv.PROD);

export function normalizeApiBase(value, { production = false } = {}) {
  const candidate = String(value || '').trim();
  if (!candidate) {
    if (production) {
      throw new Error('VITE_API_BASE is required for production builds.');
    }
    return '';
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('VITE_API_BASE must be a valid absolute URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('VITE_API_BASE must use HTTP or HTTPS.');
  }
  if (production && parsed.protocol !== 'https:') {
    throw new Error('VITE_API_BASE must use HTTPS in production.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('VITE_API_BASE cannot contain credentials, a query, or a fragment.');
  }
  if (parsed.pathname !== '/') {
    throw new Error('VITE_API_BASE must be an origin without a path.');
  }

  return parsed.origin;
}

const browserHostname = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const developmentFallback = `http://${browserHostname}:8000`;

export const API_BASE = normalizeApiBase(
  viteEnv.VITE_API_BASE || (isProduction ? '' : developmentFallback),
  { production: isProduction },
);
