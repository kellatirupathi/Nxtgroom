import { getSetting, saveSetting } from "../stores/settingsStore.js";

const SETTINGS_ID = "config_settings";

export const DEFAULT_CONFIG_SETTINGS = Object.freeze({
  allow_move_while_checked_in: false,
});

const BOOLEAN_KEYS = Object.keys(DEFAULT_CONFIG_SETTINGS);

export function normalizeConfigSettings(raw = {}) {
  const normalized = {};
  for (const key of BOOLEAN_KEYS) {
    normalized[key] = typeof raw?.[key] === "boolean"
      ? raw[key]
      : DEFAULT_CONFIG_SETTINGS[key];
  }
  return normalized;
}

export function validateConfigSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, detail: "Config settings must be an object" };
  }
  const unknown = Object.keys(body).filter((key) => !BOOLEAN_KEYS.includes(key));
  if (unknown.length) {
    return { valid: false, detail: `Unsupported config settings: ${unknown.join(", ")}` };
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

export function clearConfigSettingsCache() {
  cache = null;
}

export async function getConfigSettings(db, { now = Date.now() } = {}) {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.settings;
  const stored = await getSetting(db, SETTINGS_ID);
  const settings = normalizeConfigSettings(stored || {});
  cache = { settings, at: now };
  return settings;
}

export async function saveConfigSettings(db, body, updatedBy = null) {
  const settings = normalizeConfigSettings({ ...(await getConfigSettings(db)), ...body });
  await saveSetting(db, SETTINGS_ID, {
    set: { ...settings, updated_at: new Date(), updated_by: updatedBy },
    setOnInsert: { _id: SETTINGS_ID, created_at: new Date() },
  });
  clearConfigSettingsCache();
  return settings;
}
