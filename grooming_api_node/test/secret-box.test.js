import assert from "node:assert/strict";
import { test } from "node:test";
import { openSecret, sealSecret } from "../src/services/secretBox.js";

const sampleToken = "token".repeat(6);
const passphrase = (label) => `${label}-passphrase-of-more-than-thirty-two-chars`;

test("a sealed value round-trips", () => {
  const token = sampleToken;
  assert.equal(openSecret(sealSecret(token)), token);
});

test("the sealed form does not contain the plaintext", () => {
  const token = sampleToken;
  const sealed = sealSecret(token);
  assert.ok(!sealed.includes(token));
  assert.notEqual(sealed, token);
});

test("sealing the same value twice never produces the same ciphertext", () => {
  const token = "same-token-every-time";
  assert.notEqual(sealSecret(token), sealSecret(token));
});

test("a tampered seal is refused rather than silently truncated", () => {
  const sealed = sealSecret(sampleToken);
  const flipped = `${sealed.slice(0, -2)}${sealed.slice(-2) === "AA" ? "AB" : "AA"}`;
  assert.throws(() => openSecret(flipped), (error) => error.code === "SEALED_VALUE_INVALID");
});

test("a malformed seal is refused", () => {
  for (const value of ["", "x", "not-base64url!!"]) {
    assert.throws(() => openSecret(value), (error) => error.code === "SEALED_VALUE_INVALID");
  }
});

test("a seal made under a different key cannot be opened", () => {
  const original = process.env.SECRET_KEY;
  process.env.SECRET_KEY = passphrase("first");
  const sealed = sealSecret(sampleToken);
  process.env.SECRET_KEY = passphrase("second");
  try {
    assert.throws(() => openSecret(sealed), (error) => error.code === "SEALED_VALUE_INVALID");
  } finally {
    if (original === undefined) delete process.env.SECRET_KEY;
    else process.env.SECRET_KEY = original;
  }
});
