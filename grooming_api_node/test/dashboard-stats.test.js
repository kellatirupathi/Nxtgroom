import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arrivalSlots,
  checkpointAudience,
  dashboardStatus,
  previousWorkingDayKey,
  workingDayKeys,
} from "../src/services/dashboardStats.js";

const ZONE = "Asia/Kolkata";
// Tuesday 29 September 2026, 5:20 PM in Kolkata.
const NOW = new Date("2026-09-29T11:50:00Z");
const TODAY = "2026-09-29";
const MONDAY = "2026-09-28";

/** A local wall-clock time on a day, as the UTC instant the database stores. */
const at = (day, time) => new Date(`${day}T${time}:00+05:30`);

test("statuses are read exactly as the Daily Records badge reads them", () => {
  assert.equal(dashboardStatus("compliant"), "compliant");
  assert.equal(dashboardStatus("DONE"), "compliant");
  assert.equal(dashboardStatus("needs_review"), "compliant");
  assert.equal(dashboardStatus("review_required"), "compliant");
  assert.equal(dashboardStatus("fail"), "non_compliant");
  assert.equal(dashboardStatus("non_compliant"), "non_compliant");
  assert.equal(dashboardStatus("unassessed"), "unassessed");
  assert.equal(dashboardStatus("unidentified"), "unidentified");
  assert.equal(dashboardStatus("error"), "error");
  assert.equal(dashboardStatus(undefined), "pending");
  assert.equal(dashboardStatus("pending"), "pending");
});

test("the working week is Monday to Saturday", () => {
  const keys = workingDayKeys(TODAY, 8);
  assert.equal(keys.length, 8);
  assert.equal(keys.at(-1), TODAY);
  assert.ok(!keys.includes("2026-09-27"), "Sunday is never a working day");
  // 29, 28, 26, 25, 24, 23, 22, 21: Sunday the 27th is skipped.
  assert.equal(keys[0], "2026-09-21");
  assert.equal(previousWorkingDayKey(TODAY), MONDAY);
  assert.equal(previousWorkingDayKey(MONDAY), "2026-09-26", "Monday's previous working day is Saturday");
});

test("checkpoints are labelled with who they apply to", () => {
  assert.equal(checkpointAudience("ID_PRESENT"), "All");
  assert.equal(checkpointAudience("M_BELT"), "Men");
  assert.equal(checkpointAudience("W_SAREE_BLOUSE"), "Saree");
  assert.equal(checkpointAudience("W_DUPATTA"), "Kurti");
  assert.equal(checkpointAudience("W_BOTTOM_WEAR"), "Kurti");
  assert.equal(checkpointAudience("W_FORMAL_TOP"), "Formal");
  assert.equal(checkpointAudience("W_HAIR_NEATNESS"), "Women");
});

test("check-ins are bucketed by local quarter hour with empty slots kept", () => {
  const slots = arrivalSlots(
    [
      { check_in_time: at(TODAY, "08:50") },
      { check_in_time: at(TODAY, "08:52") },
      { check_in_time: at(TODAY, "09:31") },
    ],
    ZONE
  );
  assert.deepEqual(slots.map((slot) => [slot.label, slot.count]), [
    ["8:45 AM", 2],
    ["9:00 AM", 0],
    ["9:15 AM", 0],
    ["9:30 AM", 1],
  ]);
  assert.equal(slots[0].end_label, "9:00 AM");
  assert.deepEqual(arrivalSlots([], ZONE), []);
});
