import crypto from "node:crypto";
import { runtimeConfig } from "../config/env.js";

/**
 * Authenticated encryption for short-lived secrets that must sit in MongoDB.
 *
 * `password_resets` deliberately stores only a SHA-256 hash of a reset token,
 * so a leaked database backup cannot be replayed to seize accounts. The mail
 * queue then undid that: a job carried the raw token in its payload until the
 * message was sent, and a failed or slow job held it for the full retention
 * window. Sealing the token keeps the durable-retry behaviour while restoring
 * the property the hash was there to provide.
 *
 * The key is derived from SECRET_KEY, which is already required to be unique
 * and at least 32 characters in production. Rotating it makes queued seals
 * unreadable, which is the correct outcome: a rotated signing key should not
 * leave old credentials redeemable.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function key() {
  return crypto.createHash("sha256").update(runtimeConfig().jwtSecret).digest();
}

/** Returns base64url(iv | tag | ciphertext). */
export function sealSecret(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

/** Throws when the value was sealed under a different key or was tampered with. */
export function openSecret(sealed) {
  const raw = Buffer.from(String(sealed), "base64url");
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw Object.assign(new Error("Sealed value is malformed"), { code: "SEALED_VALUE_INVALID" });
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw Object.assign(new Error("Sealed value could not be opened"), { code: "SEALED_VALUE_INVALID" });
  }
}
