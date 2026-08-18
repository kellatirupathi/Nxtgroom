import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canDeleteAttendance,
  clearAccessSettingsCache,
  describeDeletePermission,
  getAccessSettings,
  normalizeAccessSettings,
  validateAccessSettings,
} from "../src/services/accessSettings.js";

/**
 * Deleting a check-in removes the record, its evaluation and its photographs,
 * with no undo. These tests hold the rule that the capability is off until
 * somebody grants it, and that granting it to one person never grants it to
 * everyone.
 */

const boa = (override) => (
  override === undefined ? { role: "BOA" } : { role: "BOA", can_delete_records: override }
);

test("nobody but an admin can delete until the workspace allows it", () => {
  const closed = { boa_can_delete_records: false };
  assert.equal(canDeleteAttendance(boa(), closed), false);
  assert.equal(canDeleteAttendance({ role: "ADMIN" }, closed), true);
  assert.equal(canDeleteAttendance({ role: "SUPER_ADMIN" }, closed), true);
  // An absent or malformed user is never granted anything by default.
  assert.equal(canDeleteAttendance(null, closed), false);
  assert.equal(canDeleteAttendance({}, closed), false);
});

test("an empty database denies BOAs rather than defaulting open", () => {
  assert.equal(normalizeAccessSettings({}).boa_can_delete_records, false);
  assert.equal(normalizeAccessSettings({ boa_can_delete_records: "yes" }).boa_can_delete_records, false);
  assert.equal(canDeleteAttendance(boa(), normalizeAccessSettings({})), false);
});

test("the workspace default reaches every BOA who has no setting of their own", () => {
  const open = { boa_can_delete_records: true };
  assert.equal(canDeleteAttendance(boa(), open), true);
});

test("a person's own setting overrides the workspace in both directions", () => {
  // Granting one BOA the capability must not require opening it to all of
  // them, and denying one must not require closing it for the rest.
  assert.equal(canDeleteAttendance(boa(true), { boa_can_delete_records: false }), true);
  assert.equal(canDeleteAttendance(boa(false), { boa_can_delete_records: true }), false);
});

test("the permissions view says where the answer came from", () => {
  // "On because the workspace allows it" and "on because someone chose it for
  // this person" behave differently later, and look identical without this.
  assert.deepEqual(describeDeletePermission(boa(), { boa_can_delete_records: true }), {
    can_delete_records: true,
    source: "WORKSPACE",
    workspace_default: true,
  });
  assert.deepEqual(describeDeletePermission(boa(true), { boa_can_delete_records: false }), {
    can_delete_records: true,
    source: "USER",
    workspace_default: false,
  });
  assert.equal(describeDeletePermission({ role: "ADMIN" }, {}).source, "ROLE");
});

test("an unknown settings key is refused rather than stored", () => {
  assert.equal(validateAccessSettings({ boa_can_delete_records: true }).valid, true);
  assert.equal(validateAccessSettings({ boa_can_delete_everything: true }).valid, false);
  assert.equal(validateAccessSettings({ boa_can_delete_records: "true" }).valid, false);
  assert.equal(validateAccessSettings(null).valid, false);
  assert.equal(validateAccessSettings([]).valid, false);
});

test("a permission change is not hidden behind the cache", async () => {
  clearAccessSettingsCache();
  let stored = { boa_can_delete_records: true };
  let reads = 0;
  const db = {
    collection: () => ({
      findOne: async () => {
        reads += 1;
        return stored;
      },
    }),
  };

  assert.equal((await getAccessSettings(db)).boa_can_delete_records, true);
  await getAccessSettings(db);
  assert.equal(reads, 1, "a repeat read within the window should not hit the database");

  // Revoking has to take effect, so the cached copy must expire rather than
  // leaving a BOA able to delete after the permission was withdrawn.
  stored = { boa_can_delete_records: false };
  const settings = await getAccessSettings(db, { now: Date.now() + 60_000 });
  assert.equal(settings.boa_can_delete_records, false);
  assert.equal(reads, 2);
  clearAccessSettingsCache();
});
