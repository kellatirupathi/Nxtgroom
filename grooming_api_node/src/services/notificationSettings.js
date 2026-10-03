import { getSetting, saveSetting } from "../stores/settingsStore.js";

const SETTINGS_ID = "notification_settings";

export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  checkin_email_enabled: true,
  checkout_email_enabled: true,
  weekly_email_enabled: false,
  only_when_non_compliant: false,
  reanalyse_enabled: false,
});

const BOOLEAN_KEYS = Object.keys(DEFAULT_NOTIFICATION_SETTINGS);

export function normalizeNotificationSettings(raw = {}) {
  const normalized = {};
  for (const key of BOOLEAN_KEYS) {
    normalized[key] = typeof raw?.[key] === "boolean"
      ? raw[key]
      : DEFAULT_NOTIFICATION_SETTINGS[key];
  }
  return normalized;
}

export function validateNotificationSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, detail: "Notification settings must be an object" };
  }
  const unknown = Object.keys(body).filter((key) => !BOOLEAN_KEYS.includes(key));
  if (unknown.length) {
    return { valid: false, detail: `Unsupported notification settings: ${unknown.join(", ")}` };
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in body && typeof body[key] !== "boolean") {
      return { valid: false, detail: `${key} must be true or false` };
    }
  }
  return { valid: true, value: normalizeNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, ...body }) };
}

export async function getNotificationSettings(db) {
  if (!db) return { ...DEFAULT_NOTIFICATION_SETTINGS };
  const stored = await getSetting(db, SETTINGS_ID);
  return normalizeNotificationSettings(stored);
}

export async function saveNotificationSettings(db, settings, updatedBy) {
  const value = normalizeNotificationSettings(settings);
  await saveSetting(db, SETTINGS_ID, {
    set: { ...value, updated_at: new Date(), updated_by: updatedBy || null },
    setOnInsert: { _id: SETTINGS_ID, created_at: new Date() },
  });
  return value;
}

export function shouldSendNotification(settings, type, evaluation = {}) {
  const config = normalizeNotificationSettings(settings);
  if (type === "checkin" && !config.checkin_email_enabled) return false;
  if (type === "checkout" && !config.checkout_email_enabled) return false;

  const status = String(
    evaluation.overallStatus ?? evaluation.overall_status ?? ""
  ).toUpperCase();
  const isNonCompliant = status === "NON_COMPLIANT"
    || status === "NON-COMPLIANT"
    || status === "FAIL";
  if (config.only_when_non_compliant && !isNonCompliant) return false;

  return true;
}

export function shouldSendWeeklyReport(settings) {
  return normalizeNotificationSettings(settings).weekly_email_enabled;
}
