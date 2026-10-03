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

const boa = (override) => (
  override === undefined ? { role: "BOA" } : { role: "BOA", can_delete_records: override }
);

test("nobody but an admin can delete until the workspace allows it", () => {
  const closed = { boa_can_delete_records: false };
  assert.equal(canDeleteAttendance(boa(), closed), false);
  assert.equal(canDeleteAttendance({ role: "ADMIN" }, closed), true);
  assert.equal(canDeleteAttendance({ role: "SUPER_ADMIN" }, closed), true);
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
  assert.equal(canDeleteAttendance(boa(true), { boa_can_delete_records: false }), true);
  assert.equal(canDeleteAttendance(boa(false), { boa_can_delete_records: true }), false);
});

test("the permissions view says where the answer came from", () => {
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

  stored = { boa_can_delete_records: false };
  const settings = await getAccessSettings(db, { now: Date.now() + 60_000 });
  assert.equal(settings.boa_can_delete_records, false);
  assert.equal(reads, 2);
  clearAccessSettingsCache();
});

test("deleting a check-out is a lesser permission than deleting the record", async () => {
  const { canDeleteCheckout } = await import("../src/services/accessSettings.js");
  const closed = { boa_can_delete_records: false, boa_can_delete_checkout: false };

  assert.equal(canDeleteCheckout({ role: "ADMIN" }, closed), true);
  assert.equal(canDeleteCheckout({ role: "BOA", can_delete_records: true }, closed), true);
  assert.equal(canDeleteCheckout({ role: "BOA" }, { boa_can_delete_records: true }), true);

  assert.equal(canDeleteCheckout({ role: "BOA" }, { boa_can_delete_checkout: true }), true);
  assert.equal(canDeleteAttendance({ role: "BOA" }, { boa_can_delete_checkout: true }), false);

  assert.equal(canDeleteCheckout({ role: "BOA" }, closed), false);
  assert.equal(canDeleteCheckout(null, closed), false);
});
