import assert from "node:assert/strict";
import { test } from "node:test";
import { ELEVATED_ROLES, isElevated, ROLES, requireRootAdmin } from "../src/middleware/auth.js";

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test("ADMIN is elevated but BOA is not", () => {
  assert.equal(isElevated(ROLES.SUPER_ADMIN), true);
  assert.equal(isElevated(ROLES.ADMIN), true);
  assert.equal(isElevated(ROLES.BOA), false);
  assert.equal(isElevated(undefined), false);
  assert.deepEqual(ELEVATED_ROLES, [ROLES.SUPER_ADMIN, ROLES.ADMIN]);
});

test("only the super admin may manage administrator accounts", () => {
  // An ADMIN must not be able to create or delete other administrators,
  // otherwise it could remove the owner and lock them out permanently.
  for (const role of [ROLES.ADMIN, ROLES.BOA, undefined]) {
    const res = fakeRes();
    let advanced = false;
    requireRootAdmin({ currentUser: role ? { role } : undefined }, res, () => { advanced = true; });
    assert.equal(advanced, false, `${role} must not reach admin management`);
    assert.equal(res.statusCode, 403);
  }

  const res = fakeRes();
  let advanced = false;
  requireRootAdmin({ currentUser: { role: ROLES.SUPER_ADMIN } }, res, () => { advanced = true; });
  assert.equal(advanced, true, "super admin passes");
  assert.equal(res.statusCode, 0);
});
