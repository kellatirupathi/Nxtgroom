import crypto from "node:crypto";

/**
 * Single-use, expiring tokens for "set your password" and "forgot password".
 *
 * Only a SHA-256 hash of each token is stored. A leaked database backup
 * therefore cannot be replayed to seize accounts, the same reason password
 * hashes are never stored in plaintext. SHA-256 (not bcrypt) is appropriate
 * here because the token is 256 bits of CSPRNG output, so there is no
 * brute-forceable low-entropy secret to slow an attacker down.
 */

const TOKEN_BYTES = 32;
export const RESET_COLLECTION = "password_resets";

/** New accounts get longer to act than a self-service reset. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;

export function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Issues a token for one account, invalidating any earlier outstanding token
 * so a forwarded older email cannot still be redeemed.
 */
export async function issueResetToken(db, { email, kind, ttlMs }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const now = new Date();

  const update = {
    $set: {
      token_hash: hashResetToken(token),
      kind,
      created_at: now,
      expires_at: new Date(now.getTime() + ttlMs),
      used_at: null,
    },
    $setOnInsert: { email: normalizedEmail },
  };
  try {
    await db.collection(RESET_COLLECTION).updateOne(
      { email: normalizedEmail }, update, { upsert: true }
    );
  } catch (error) {
    // Two first-time reset requests can both attempt the upsert. The unique
    // email index chooses one insert; retrying as a plain update makes the
    // latest request authoritative without leaving multiple live tokens.
    if (error.code !== 11000) throw error;
    await db.collection(RESET_COLLECTION).updateOne({ email: normalizedEmail }, update);
  }

  return token;
}

/**
 * Redeems a token, returning the owning email or a reason it was refused.
 * The delete is the atomic step: only the caller whose delete actually
 * matched a document proceeds, so two concurrent requests with the same
 * token cannot both set a password.
 */
export async function consumeResetToken(db, token, { session } = {}) {
  if (!token || typeof token !== "string") return { error: "invalid" };

  const tokenHash = hashResetToken(token);
  const record = await db.collection(RESET_COLLECTION).findOne({ token_hash: tokenHash }, { session });
  if (!record) return { error: "invalid" };

  if (record.expires_at && record.expires_at.getTime() < Date.now()) {
    await db.collection(RESET_COLLECTION).deleteOne({ _id: record._id }, { session });
    return { error: "expired" };
  }

  const claimed = await db.collection(RESET_COLLECTION).deleteOne(
    { _id: record._id, token_hash: tokenHash },
    { session }
  );
  if (claimed.deletedCount !== 1) return { error: "invalid" };

  return { email: record.email, kind: record.kind };
}

/** Reports whether a token could be redeemed, without consuming it. */
export async function peekResetToken(db, token) {
  if (!token || typeof token !== "string") return { error: "invalid" };
  const record = await db.collection(RESET_COLLECTION).findOne({ token_hash: hashResetToken(token) });
  if (!record) return { error: "invalid" };
  if (record.expires_at && record.expires_at.getTime() < Date.now()) return { error: "expired" };
  return { email: record.email, kind: record.kind };
}
