import assert from "node:assert/strict";
import { test } from "node:test";
import {
  googleClientId,
  isGoogleLoginEnabled,
  verifyGoogleIdToken,
} from "../src/services/googleAuth.js";

test("google login stays disabled until a client id is configured", () => {
  const original = process.env.GOOGLE_CLIENT_ID;
  try {
    delete process.env.GOOGLE_CLIENT_ID;
    assert.equal(isGoogleLoginEnabled(), false);
    assert.equal(googleClientId(), "");

    process.env.GOOGLE_CLIENT_ID = "  123-abc.apps.googleusercontent.com  ";
    assert.equal(isGoogleLoginEnabled(), true);
    assert.equal(googleClientId(), "123-abc.apps.googleusercontent.com", "value is trimmed");
  } finally {
    if (original === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = original;
  }
});

test("verification refuses to run when sign-in is not configured", async () => {
  const original = process.env.GOOGLE_CLIENT_ID;
  try {
    delete process.env.GOOGLE_CLIENT_ID;
    const result = await verifyGoogleIdToken("any.token.value");
    assert.equal(result.email, undefined);
    assert.match(result.error, /not configured/i);
  } finally {
    if (original === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = original;
  }
});

test("malformed credentials are rejected before any network call", async () => {
  const original = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com";
  try {
    for (const bad of [undefined, null, 42, "", "short", "x".repeat(5000), {}]) {
      const result = await verifyGoogleIdToken(bad);
      assert.equal(result.email, undefined, `accepted a bad credential: ${typeof bad}`);
      assert.equal(result.error, "Invalid Google credential");
    }
  } finally {
    if (original === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = original;
  }
});

test("a forged token fails signature verification", async () => {
  const original = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com";
  try {
    // Structurally valid JWT claiming a verified admin address, unsigned by Google.
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({
      email: "admin@nxtwave.com",
      email_verified: true,
      aud: "123-abc.apps.googleusercontent.com",
      iss: "https://accounts.google.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString("base64url");
    const forged = `${header}.${body}.not-a-real-signature`;

    const result = await verifyGoogleIdToken(forged);
    assert.equal(result.email, undefined, "a forged token must never yield an email");
    assert.equal(result.error, "Invalid Google credential");
  } finally {
    if (original === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = original;
  }
});
