import crypto from "node:crypto";

const TOKEN_BYTES = 32;
export const RESET_COLLECTION = "password_resets";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;

export function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

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
    if (error.code !== 11000) throw error;
    await db.collection(RESET_COLLECTION).updateOne({ email: normalizedEmail }, update);
  }

  return token;
}

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

export async function peekResetToken(db, token) {
  if (!token || typeof token !== "string") return { error: "invalid" };
  const record = await db.collection(RESET_COLLECTION).findOne({ token_hash: hashResetToken(token) });
  if (!record) return { error: "invalid" };
  if (record.expires_at && record.expires_at.getTime() < Date.now()) return { error: "expired" };
  return { email: record.email, kind: record.kind };
}
