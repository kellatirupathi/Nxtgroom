import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeNotificationSettings,
  shouldSendNotification,
  validateNotificationSettings,
} from "../src/services/notificationSettings.js";

test("defaults preserve the previous always-send behaviour", () => {
  assert.equal(shouldSendNotification(DEFAULT_NOTIFICATION_SETTINGS, "checkin", {}), true);
  assert.equal(shouldSendNotification(DEFAULT_NOTIFICATION_SETTINGS, "checkout", {}), true);
  // An empty/missing document must not silently disable mail.
  assert.deepEqual(normalizeNotificationSettings(undefined), DEFAULT_NOTIFICATION_SETTINGS);
});

test("per-type switches only suppress their own report", () => {
  const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, checkin_email_enabled: false };
  assert.equal(shouldSendNotification(settings, "checkin", {}), false);
  assert.equal(shouldSendNotification(settings, "checkout", {}), true);
});

test("suppression filters are OR-ed and accept either payload casing", () => {
  const nonCompliantOnly = { ...DEFAULT_NOTIFICATION_SETTINGS, only_when_non_compliant: true };
  assert.equal(shouldSendNotification(nonCompliantOnly, "checkin", { overallStatus: "COMPLIANT" }), false);
  assert.equal(shouldSendNotification(nonCompliantOnly, "checkin", { overallStatus: "NON_COMPLIANT" }), true);
  assert.equal(shouldSendNotification(nonCompliantOnly, "checkin", { overall_status: "NON_COMPLIANT" }), true);

  const both = { ...nonCompliantOnly };
  assert.equal(
    shouldSendNotification(both, "checkin", { overallStatus: "NON_COMPLIANT" }),
    true,
    "matching either enabled filter is enough"
  );
  assert.equal(
    shouldSendNotification(both, "checkin", { overallStatus: "COMPLIANT" }),
    false
  );
});

test("validation rejects unknown keys and non-boolean values", () => {
  assert.equal(validateNotificationSettings({ nope: true }).valid, false);
  assert.equal(validateNotificationSettings({ checkin_email_enabled: "yes" }).valid, false);
  assert.equal(validateNotificationSettings(null).valid, false);
  const ok = validateNotificationSettings({ checkin_email_enabled: false });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.value, { ...DEFAULT_NOTIFICATION_SETTINGS, checkin_email_enabled: false });
});
