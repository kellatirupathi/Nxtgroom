import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccessToken, getCurrentUser } from "../src/middleware/auth.js";
import {
  canDeleteAttendance,
  canDeleteCheckout,
  DEFAULT_ACCESS_SETTINGS,
} from "../src/services/accessSettings.js";

/**
 * canDeleteCheckout() consults user.can_delete_checkout so one BOA can be
 * granted the lesser permission without opening it to everyone. getCurrentUser
 * never copied that field off the user document, so the branch could not be
 * reached: a value set on an account was ignored and everybody silently fell
 * back to the workspace default instead.
 */

function fakeDb(user, boa = { _id: "b1", college_id: "c1" }) {
  return {
    collection(name) {
      if (name === "users") return { findOne: async () => user };
      if (name === "boas") return { findOne: async () => boa };
      throw new Error(`unexpected collection ${name}`);
    },
  };
}

async function currentUserFor(user) {
  const token = createAccessToken({
    sub: user.email,
    role: user.role,
    sessionVersion: user.session_version ?? 0,
  });
  const req = {
    headers: { authorization: `Bearer ${token}` },
    app: { locals: { db: fakeDb(user) } },
  };
  const res = { set: () => res, status: () => res, json: (body) => { res.body = body; return res; } };
  let called = false;
  await getCurrentUser(req, res, () => { called = true; });
  assert.ok(called, `authentication was rejected: ${JSON.stringify(res.body)}`);
  return req.currentUser;
}

const boaUser = (overrides = {}) => ({
  _id: "u1",
  email: "boa@example.com",
  role: "BOA",
  reference_id: "b1",
  session_version: 0,
  ...overrides,
});

test("a per-account check-out permission reaches the permission check", async () => {
  const granted = await currentUserFor(boaUser({ can_delete_checkout: true }));

  assert.equal(granted.can_delete_checkout, true, "the field must survive authentication");
  assert.equal(canDeleteCheckout(granted, DEFAULT_ACCESS_SETTINGS), true);
  // The lesser permission must not imply the greater one.
  assert.equal(canDeleteAttendance(granted, DEFAULT_ACCESS_SETTINGS), false);
});

test("a per-account denial overrides an open workspace default", async () => {
  const denied = await currentUserFor(boaUser({ can_delete_checkout: false }));

  assert.equal(denied.can_delete_checkout, false);
  assert.equal(
    canDeleteCheckout(denied, { boa_can_delete_records: false, boa_can_delete_checkout: true }),
    false,
    "an explicit false for this person must win over the workspace default"
  );
});

test("no override means the workspace default still decides", async () => {
  const plain = await currentUserFor(boaUser());

  assert.equal("can_delete_checkout" in plain, false, "absent is distinct from false");
  assert.equal(canDeleteCheckout(plain, DEFAULT_ACCESS_SETTINGS), false);
  assert.equal(
    canDeleteCheckout(plain, { boa_can_delete_records: false, boa_can_delete_checkout: true }),
    true
  );
});

test("the record permission still carries through and implies the check-out one", async () => {
  const granted = await currentUserFor(boaUser({ can_delete_records: true }));

  assert.equal(granted.can_delete_records, true);
  assert.equal(canDeleteCheckout(granted, DEFAULT_ACCESS_SETTINGS), true);
});
