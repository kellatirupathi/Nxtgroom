import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Photographs expire; their reports do not. The checkpoints, observations and
 * summary live in MongoDB, so an old record stays fully readable with no image
 * behind it.
 *
 * The pairing is what matters here. Deleting from the bucket alone leaves the
 * key on the record, and the interface offers a photo button whenever a key is
 * present — so every expired record would show a button that opens an error.
 */

/** The retention rule, expressed the way the endpoint computes it. */
function cutoffFor(months, now) {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

test("two months is the window, counted in calendar months", () => {
  const now = new Date("2026-08-19T00:00:00.000Z");
  assert.equal(cutoffFor(2, now).toISOString(), "2026-06-19T00:00:00.000Z");
  // Crossing a year boundary must not land in the wrong year.
  assert.equal(cutoffFor(2, new Date("2026-01-15T00:00:00.000Z")).toISOString(), "2025-11-15T00:00:00.000Z");
});

test("only records older than the cutoff are selected", () => {
  const cutoff = cutoffFor(2, new Date("2026-08-19T00:00:00.000Z"));
  const olderThanCutoff = (date) => new Date(date) < cutoff;

  assert.equal(olderThanCutoff("2026-05-01T00:00:00.000Z"), true, "three months old expires");
  assert.equal(olderThanCutoff("2026-06-18T23:59:00.000Z"), true, "just past two months expires");
  assert.equal(olderThanCutoff("2026-06-20T00:00:00.000Z"), false, "inside two months is kept");
  assert.equal(olderThanCutoff("2026-08-18T00:00:00.000Z"), false, "yesterday is kept");
});

test("a key is cleared only when its object was really deleted", () => {
  // A storage outage must leave the record untouched so the next run retries.
  // Clearing the key regardless would orphan a file nothing points at, and it
  // would then never be found again.
  const applyResult = (record, field, result) => (
    result.deleted ? { ...record, [field]: null } : record
  );

  const record = { check_in_photo_key: "attendance/2026/05/01/x-checkin-ab.jpg" };
  assert.equal(applyResult(record, "check_in_photo_key", { deleted: true }).check_in_photo_key, null);
  assert.equal(
    applyResult(record, "check_in_photo_key", { deleted: false, reason: "TimeoutError" }).check_in_photo_key,
    record.check_in_photo_key
  );
});

test("a record keeps everything except its photographs", () => {
  // The report is what the check-in is for. Only the image is disposable.
  const purged = (record) => ({ ...record, check_in_photo_key: null, check_out_photo_key: null });
  const before = {
    _id: "a1",
    status: "non_compliant",
    remarks: "The shirt is not full-sleeve.",
    attire_type: "FORMAL",
    location_address: "Brigade Towers, Hyderabad",
    check_in_photo_key: "attendance/2026/05/01/x-checkin-ab.jpg",
    check_out_photo_key: "attendance/2026/05/01/x-checkout-cd.jpg",
  };
  const after = purged(before);
  for (const field of ["status", "remarks", "attire_type", "location_address"]) {
    assert.equal(after[field], before[field], `${field} must survive the purge`);
  }
  assert.equal(after.check_in_photo_key, null);
  assert.equal(after.check_out_photo_key, null);
});
