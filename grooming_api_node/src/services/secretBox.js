import crypto from "node:crypto";
import { runtimeConfig } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function key() {
  return crypto.createHash("sha256").update(runtimeConfig().jwtSecret).digest();
}

export function sealSecret(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

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
