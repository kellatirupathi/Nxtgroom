import assert from "node:assert/strict";
import { test } from "node:test";
import { isElevated, ROLES } from "../src/middleware/auth.js";

/**
 * The ADMIN role was added after these scope helpers were written, and several
 * of them tested for SUPER_ADMIN by name. An administrator has no college_id,
 * so those filters matched nothing: Daily Records rendered empty and every
 * table showed "Unknown college" even though the data was present.
 *
 * These assert the rule the routes now share, so a future scope check written
 * against a single role fails here rather than in production.
 */

test("both elevated roles see data across every college", () => {
  assert.equal(isElevated(ROLES.SUPER_ADMIN), true);
  assert.equal(isElevated(ROLES.ADMIN), true, "an admin is not scoped to one college");
});

test("a BOA remains scoped to their own college", () => {
  assert.equal(isElevated(ROLES.BOA), false);
});

test("unknown and missing roles are never treated as elevated", () => {
  for (const role of [null, undefined, "", "GUEST", "admin", "super_admin"]) {
    assert.equal(isElevated(role), false, `${JSON.stringify(role)} must not be elevated`);
  }
});

/** Mirrors the scope helper shared by the attendance and college listings. */
function scopeFor(currentUser, field) {
  return isElevated(currentUser?.role) ? {} : { [field]: String(currentUser?.collegeId) };
}

test("an admin without a college is not filtered down to nothing", () => {
  const admin = { role: ROLES.ADMIN, collegeId: null };
  assert.deepEqual(
    scopeFor(admin, "college_id"),
    {},
    "an unfiltered scope is what makes their records visible",
  );

  const boa = { role: ROLES.BOA, collegeId: "college-1" };
  assert.deepEqual(scopeFor(boa, "college_id"), { college_id: "college-1" });
});
