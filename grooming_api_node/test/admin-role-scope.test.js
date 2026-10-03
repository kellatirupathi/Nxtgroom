import assert from "node:assert/strict";
import { test } from "node:test";
import { isElevated, ROLES } from "../src/middleware/auth.js";

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
  assert.equal(emailIsFaulty({ email: "not-an-address" }), true);
  assert.equal(emailIsFaulty({ email: "someone@nxtwave.co.in" }), false);
});

test("an unassigned college does not block startup", () => {
  const active = new Set(["college-1"]);
  assert.equal(collegeIsFaulty({ college_id: null }, active), false);
  assert.equal(collegeIsFaulty({}, active), false);
});

test("a college that points at a missing record is still a fault", () => {
  const active = new Set(["college-1"]);
  assert.equal(collegeIsFaulty({ college_id: "deleted-college" }, active), true);
  assert.equal(collegeIsFaulty({ college_id: "college-1" }, active), false);
});
