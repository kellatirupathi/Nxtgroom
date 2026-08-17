const SETTINGS_ID = "rp_recipients";
const MAX_RECIPIENTS = 50;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reporting Partners: addresses that are copied on grooming alerts alongside
 * the instructor, so someone accountable sees a failed audit without having
 * to watch the dashboard.
 */

export function normaliseEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function isValidRecipient(value) {
  const email = normaliseEmail(value);
  return Boolean(email) && email.length <= 254 && EMAIL_PATTERN.test(email);
}

export async function getReportRecipients(db) {
  const document = await db.collection("app_settings").findOne({ _id: SETTINGS_ID });
  const emails = Array.isArray(document?.emails) ? document.emails : [];
  return emails.filter(isValidRecipient);
}

/**
 * Adds one address. Returns the reason on refusal rather than throwing, so the
 * route can report it without a try/catch.
 */
export async function addReportRecipient(db, value, addedBy) {
  const email = normaliseEmail(value);
  if (!isValidRecipient(email)) return { ok: false, reason: "invalid" };

  const current = await getReportRecipients(db);
  if (current.includes(email)) return { ok: false, reason: "duplicate" };
  if (current.length >= MAX_RECIPIENTS) return { ok: false, reason: "limit" };

  const now = new Date();
  await db.collection("app_settings").updateOne(
    { _id: SETTINGS_ID },
    {
      // addToSet rather than push: two administrators adding the same address
      // at once would otherwise store it twice.
      $addToSet: { emails: email },
      $set: { updated_at: now, updated_by: addedBy || null },
      $setOnInsert: { _id: SETTINGS_ID, created_at: now },
    },
    { upsert: true }
  );
  return { ok: true, emails: await getReportRecipients(db) };
}

export async function removeReportRecipient(db, value, removedBy) {
  const email = normaliseEmail(value);
  if (!email) return { ok: false, reason: "invalid" };
  await db.collection("app_settings").updateOne(
    { _id: SETTINGS_ID },
    { $pull: { emails: email }, $set: { updated_at: new Date(), updated_by: removedBy || null } }
  );
  return { ok: true, emails: await getReportRecipients(db) };
}
