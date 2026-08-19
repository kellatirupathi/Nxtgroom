import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addReportRecipient,
  getReportRecipients,
  isValidRecipient,
  normaliseEmail,
  removeReportRecipient,
} from "../src/services/reportRecipients.js";

/**
 * Reporting partners are copied on every failed check-in. When they stopped
 * arriving there was nothing to inspect: the addresses were stored correctly
 * the whole time, and the alert was failing much earlier, at an instructor
 * lookup that matched nobody. These cover the half that is this module's —
 * that every configured address survives storage and comes back out.
 */

function fakeDb(document) {
  let stored = document;
  return {
    saved: () => stored,
    collection(name) {
      assert.equal(name, "app_settings");
      return {
        findOne: async () => stored,
        updateOne: async (_filter, update) => {
          const emails = new Set(stored?.emails || []);
          if (update.$addToSet?.emails) emails.add(update.$addToSet.emails);
          if (update.$pull?.emails) emails.delete(update.$pull.emails);
          stored = { ...(stored || {}), emails: [...emails] };
          return { matchedCount: 1 };
        },
      };
    },
  };
}

test("every configured address is returned, not just the first", () => {
  // The alert loops over this list. A silent truncation here would look
  // exactly like an email failure.
  const db = fakeDb({ emails: ["one@nxtwave.co.in", "two@nxtwave.co.in", "three@gmail.com"] });
  return getReportRecipients(db).then((emails) => {
    assert.deepEqual(emails, ["one@nxtwave.co.in", "two@nxtwave.co.in", "three@gmail.com"]);
  });
});

test("a single configured address still comes back", async () => {
  assert.deepEqual(await getReportRecipients(fakeDb({ emails: ["solo@nxtwave.co.in"] })), [
    "solo@nxtwave.co.in",
  ]);
});

test("no configured partners is an empty list, not a failure", async () => {
  assert.deepEqual(await getReportRecipients(fakeDb(null)), []);
  assert.deepEqual(await getReportRecipients(fakeDb({})), []);
  assert.deepEqual(await getReportRecipients(fakeDb({ emails: "not-an-array" })), []);
});

test("a malformed stored address is skipped without losing the valid ones", async () => {
  // One bad row must not stop everyone else being alerted.
  const emails = await getReportRecipients(
    fakeDb({ emails: ["good@nxtwave.co.in", "not-an-email", "", null, "also.good@gmail.com"] })
  );
  assert.deepEqual(emails, ["good@nxtwave.co.in", "also.good@gmail.com"]);
});

test("addresses are stored in one canonical form", async () => {
  // Otherwise the same partner can be added twice and receive two copies.
  assert.equal(normaliseEmail("  RP@NxtWave.co.in  "), "rp@nxtwave.co.in");
  const db = fakeDb({ emails: [] });
  await addReportRecipient(db, "  RP@NxtWave.co.in ", "admin@nxtwave.com");
  const duplicate = await addReportRecipient(db, "rp@nxtwave.co.in", "admin@nxtwave.com");
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, "duplicate");
  assert.deepEqual(await getReportRecipients(db), ["rp@nxtwave.co.in"]);
});

test("an invalid address is refused rather than stored and skipped later", async () => {
  const db = fakeDb({ emails: [] });
  for (const bad of ["", "   ", "no-at-sign", "missing@domain", "a@b", `${"x".repeat(250)}@nxtwave.co.in`]) {
    assert.equal(isValidRecipient(bad), false, `${bad} should be refused`);
    assert.equal((await addReportRecipient(db, bad, "admin@nxtwave.com")).ok, false);
  }
  assert.deepEqual(await getReportRecipients(db), []);
});

test("removing one partner leaves the others receiving alerts", async () => {
  const db = fakeDb({ emails: ["a@nxtwave.co.in", "b@nxtwave.co.in"] });
  await removeReportRecipient(db, "A@NxtWave.co.in", "admin@nxtwave.com");
  assert.deepEqual(await getReportRecipients(db), ["b@nxtwave.co.in"]);
});

test("partners are copied per half, each behind its own switch", async () => {
  const { reportRecipientsFor, getRecipientEvents } = await import("../src/services/reportRecipients.js");
  const db = (doc) => ({
    collection() { return { findOne: async () => doc }; },
  });

  const both = { emails: ["rp@nxtwave.co.in"], checkin_enabled: true, checkout_enabled: true };
  assert.deepEqual(await reportRecipientsFor(db(both), "checkin"), ["rp@nxtwave.co.in"]);
  assert.deepEqual(await reportRecipientsFor(db(both), "checkout"), ["rp@nxtwave.co.in"]);

  // Each switch governs only its own half.
  const checkinOnly = { ...both, checkout_enabled: false };
  assert.deepEqual(await reportRecipientsFor(db(checkinOnly), "checkin"), ["rp@nxtwave.co.in"]);
  assert.deepEqual(await reportRecipientsFor(db(checkinOnly), "checkout"), []);

  const checkoutOnly = { ...both, checkin_enabled: false };
  assert.deepEqual(await reportRecipientsFor(db(checkoutOnly), "checkin"), []);
  assert.deepEqual(await reportRecipientsFor(db(checkoutOnly), "checkout"), ["rp@nxtwave.co.in"]);

  // A configuration saved before these existed keeps behaving as it did.
  const legacy = { emails: ["rp@nxtwave.co.in"] };
  assert.deepEqual(await getRecipientEvents(db(legacy)), { checkin_enabled: true, checkout_enabled: true });
  assert.deepEqual(await reportRecipientsFor(db(legacy), "checkout"), ["rp@nxtwave.co.in"]);
});
