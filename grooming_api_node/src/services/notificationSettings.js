/**
 * Workspace-wide email notification preferences.
 *
 * Stored as a single document so the notification worker can consult one
 * cheap read before queueing mail. Defaults are permissive (both reports on,
 * no suppression) so an empty database behaves exactly like the previous
 * always-send implementation for per-attendance reports. Weekly summaries are
 * opt-in so a new workspace cannot start a roster-wide mailing unexpectedly.
 */

const SETTINGS_ID = "notification_settings";

export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  checkin_email_enabled: true,
  checkout_email_enabled: true,
  weekly_email_enabled: false,
  only_when_non_compliant: false,
  // Re-running an evaluation costs a vision call and overwrites the report an
  // instructor may already have been emailed, so the control stays hidden
  // until a workspace deliberately turns it on.
  reanalyse_enabled: false,
});

const BOOLEAN_KEYS = Object.keys(DEFAULT_NOTIFICATION_SETTINGS);

/** Coerces a stored or submitted document into a complete, boolean-only shape. */
export function normalizeNotificationSettings(raw = {}) {
  const normalized = {};
  for (const key of BOOLEAN_KEYS) {
    normalized[key] = typeof raw?.[key] === "boolean"
      ? raw[key]
      : DEFAULT_NOTIFICATION_SETTINGS[key];
  }
  return normalized;
}

/** Rejects unknown keys and non-boolean values so a typo cannot silently persist. */
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
  const stored = await db.collection("app_settings").findOne({ _id: SETTINGS_ID });
  return normalizeNotificationSettings(stored);
}

export async function saveNotificationSettings(db, settings, updatedBy) {
  const value = normalizeNotificationSettings(settings);
  await db.collection("app_settings").updateOne(
    { _id: SETTINGS_ID },
    {
      $set: { ...value, updated_at: new Date(), updated_by: updatedBy || null },
      $setOnInsert: { _id: SETTINGS_ID, created_at: new Date() },
    },
    { upsert: true }
  );
  return value;
}

/**
 * Decides whether a report email should be queued.
 * `type` is "checkin" | "checkout"; the evaluation flags are optional so a
 * checkout with no evaluation still resolves cleanly.
 */
export function shouldSendNotification(settings, type, evaluation = {}) {
  const config = normalizeNotificationSettings(settings);
  if (type === "checkin" && !config.checkin_email_enabled) return false;
  if (type === "checkout" && !config.checkout_email_enabled) return false;

  // Report payloads use camelCase (overallStatus) while stored evaluation
  // documents use snake_case; accept either so callers cannot silently bypass
  // a suppression filter by passing the other shape.
  const status = String(
    evaluation.overallStatus ?? evaluation.overall_status ?? ""
  ).toUpperCase();
  const isNonCompliant = status === "NON_COMPLIANT"
    || status === "NON-COMPLIANT"
    || status === "FAIL";
  if (config.only_when_non_compliant && !isNonCompliant) return false;

  return true;
}

/** Weekly summaries have their own opt-in and are not affected by result filters. */
export function shouldSendWeeklyReport(settings) {
  return normalizeNotificationSettings(settings).weekly_email_enabled;
}
