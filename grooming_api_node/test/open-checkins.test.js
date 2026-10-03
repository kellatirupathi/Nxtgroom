import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeOpenCheckIns,
  dayToClose,
  NOT_CHECKED_OUT,
  openCheckInFilter,
} from "../src/services/openCheckIns.js";

const zone = "Asia/Kolkata";
const ist = (hour, minute = 0) => new Date(Date.UTC(2026, 8, 11, hour - 5, minute - 30));

function fakeDb() {
  const calls = [];
  return {
    calls,
    collection() {
      return {
        async updateMany(filter, update) {
          calls.push({ filter, update });
          return { modifiedCount: 2 };
        },
        async countDocuments() {
          return 7;
        },
      };
    },
  };
}

test("a midnight run closes the day that just ended, not the one starting", () => {
  const justAfterMidnight = new Date(Date.UTC(2026, 8, 11, 18, 35));
  assert.equal(dayToClose(justAfterMidnight, { timeZone: zone }), "2026-09-11");
});

test("a run at midnight exactly still closes yesterday", () => {
  const atMidnight = new Date(Date.UTC(2026, 8, 11, 18, 30));
  assert.equal(dayToClose(atMidnight, { timeZone: zone }), "2026-09-11");
});

test("a run late in the evening would close the same day, which is why it is scheduled for midnight", () => {
  assert.equal(dayToClose(ist(23, 0), { timeZone: zone }), "2026-09-11");
});

test("only records with no check-out are matched", () => {
  const filter = openCheckInFilter("2026-09-11", { timeZone: zone });
  assert.equal(filter.check_out_time, null);
});

test("already marked records are skipped, so a repeat run writes nothing", () => {
  const filter = openCheckInFilter("2026-09-11", { timeZone: zone });
  assert.deepEqual(filter.checkout_status, { $ne: NOT_CHECKED_OUT });
});

test("unidentified records are left to the identify queue", () => {
  const filter = openCheckInFilter("2026-09-11", { timeZone: zone });
  assert.deepEqual(filter.instructor_id, { $type: "string" });
});

test("records being deleted are not touched", () => {
  const filter = openCheckInFilter("2026-09-11", { timeZone: zone });
  assert.deepEqual(filter.deleting_at, { $exists: false });
});

test("older records without a day key are matched by their check-in instant", () => {
  const filter = openCheckInFilter("2026-09-11", { timeZone: zone });
  const [byDay, byInstant] = filter.$or;
  assert.equal(byDay.attendance_day, "2026-09-11");
  assert.deepEqual(byInstant.attendance_day, { $exists: false });
  assert.ok(byInstant.check_in_time.$gte instanceof Date);
  assert.ok(byInstant.check_in_time.$lt instanceof Date);
  const hours = (byInstant.check_in_time.$lt - byInstant.check_in_time.$gte) / 3_600_000;
  assert.equal(hours, 24);
});

test("marking writes the status and when it was set, and reports the count", async () => {
  const db = fakeDb();
  const now = ist(23, 59);
  const result = await closeOpenCheckIns(db, { dayKey: "2026-09-11", now });

  assert.equal(result.day, "2026-09-11");
  assert.equal(result.marked, 2);

  const [{ update }] = db.calls;
  assert.equal(update.$set.checkout_status, NOT_CHECKED_OUT);
  assert.equal(update.$set.checkout_status_set_at, now);
  assert.equal(update.$set.updated_at, now);
});

test("nothing about the check-in itself is rewritten", async () => {
  const db = fakeDb();
  await closeOpenCheckIns(db, { dayKey: "2026-09-11" });
  const [{ update }] = db.calls;
  for (const field of ["check_in_time", "check_in_photo_key", "location_coordinates", "status", "instructor_id"]) {
    assert.equal(update.$set[field], undefined, `${field} must not be rewritten`);
  }
  assert.equal(update.$set.check_out_time, undefined);
});

test("the day defaults to yesterday when none is given", async () => {
  const db = fakeDb();
  const result = await closeOpenCheckIns(db, { now: new Date(Date.UTC(2026, 8, 11, 18, 35)) });
  assert.equal(result.day, "2026-09-11");
});
