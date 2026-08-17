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

/**
 * Startup must not depend on every instructor being ready to check in.
 * Importing 599 instructors from BigQuery — half without an email, all
 * without a college — blocked the server from booting with
 * INSTRUCTOR_EMAIL_INVALID and ACTIVE_INSTRUCTOR_COLLEGE_INVALID, taking the
 * whole API down. These mirror the relaxed rules.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailIsFaulty(instructor) {
  const email = instructor.email;
  if (email === null || email === undefined || email === "") return false;
  return typeof email !== "string" || email.length > 254 || !EMAIL_PATTERN.test(email);
}

function collegeIsFaulty(instructor, activeCollegeIds) {
  const id = instructor.college_id;
  if (id === null || id === undefined || id === "") return false;
  return !activeCollegeIds.has(String(id));
}

test("an instructor with no email does not block startup", () => {
  assert.equal(emailIsFaulty({ email: null }), false);
  assert.equal(emailIsFaulty({ email: undefined }), false);
  assert.equal(emailIsFaulty({}), false);
});

test("an address that is present must still be valid", () => {
  // A typo would silently break the grooming report, so it stays a fault.
  assert.equal(emailIsFaulty({ email: "not-an-address" }), true);
  assert.equal(emailIsFaulty({ email: "someone@nxtwave.co.in" }), false);
});

test("an unassigned college does not block startup", () => {
  const active = new Set(["college-1"]);
  assert.equal(collegeIsFaulty({ college_id: null }, active), false);
  assert.equal(collegeIsFaulty({}, active), false);
});

test("a college that points at a missing record is still a fault", () => {
  // Attendance is scoped by college, so a dangling reference is real breakage.
  const active = new Set(["college-1"]);
  assert.equal(collegeIsFaulty({ college_id: "deleted-college" }, active), true);
  assert.equal(collegeIsFaulty({ college_id: "college-1" }, active), false);
});
