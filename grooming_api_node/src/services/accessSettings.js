import { isElevated } from "../middleware/auth.js";
import { getSetting, saveSetting } from "../stores/settingsStore.js";

const SETTINGS_ID = "access_settings";

export const DEFAULT_ACCESS_SETTINGS = Object.freeze({
  boa_can_delete_records: false,
  boa_can_delete_checkout: false,
});

const BOOLEAN_KEYS = Object.keys(DEFAULT_ACCESS_SETTINGS);

export function normalizeAccessSettings(raw = {}) {
  const normalized = {};
  for (const key of BOOLEAN_KEYS) {
    normalized[key] = typeof raw?.[key] === "boolean"
      ? raw[key]
      : DEFAULT_ACCESS_SETTINGS[key];
  }
  return normalized;
}

export function validateAccessSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, detail: "Access settings must be an object" };
  }
  const unknown = Object.keys(body).filter((key) => !BOOLEAN_KEYS.includes(key));
  if (unknown.length) {
    return { valid: false, detail: `Unsupported access settings: ${unknown.join(", ")}` };
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in body && typeof body[key] !== "boolean") {
      return { valid: false, detail: `${key} must be true or false` };
    }
  }
  return { valid: true };
}

const CACHE_TTL_MS = 30_000;
let cache = null;

export function clearAccessSettingsCache() {
  cache = null;
}

export async function getAccessSettings(db, { now = Date.now() } = {}) {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.settings;
  const stored = await getSetting(db, SETTINGS_ID);
  const settings = normalizeAccessSettings(stored || {});
  cache = { settings, at: now };
  return settings;
}

export async function saveAccessSettings(db, body) {
  const settings = normalizeAccessSettings({ ...(await getAccessSettings(db)), ...body });
  await saveSetting(db, SETTINGS_ID, { set: { ...settings, updated_at: new Date() } });
  clearAccessSettingsCache();
  return settings;
}

export function canDeleteAttendance(user, settings = DEFAULT_ACCESS_SETTINGS) {
  if (!user?.role) return false;
  if (isElevated(user.role)) return true;
  if (typeof user.can_delete_records === "boolean") return user.can_delete_records;
  return Boolean(settings?.boa_can_delete_records);
}

export function canDeleteCheckout(user, settings = DEFAULT_ACCESS_SETTINGS) {
  if (canDeleteAttendance(user, settings)) return true;
  if (typeof user?.can_delete_checkout === "boolean") return user.can_delete_checkout;
  return Boolean(settings?.boa_can_delete_checkout);
}

export function describeDeletePermission(user, settings = DEFAULT_ACCESS_SETTINGS) {
  const overridden = typeof user?.can_delete_records === "boolean";
  return {
    can_delete_records: canDeleteAttendance(user, settings),
    source: isElevated(user?.role) ? "ROLE" : overridden ? "USER" : "WORKSPACE",
    workspace_default: Boolean(settings?.boa_can_delete_records),
  };
}
