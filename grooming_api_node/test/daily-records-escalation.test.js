import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { escalationFor, weeklyEscalations } from "../src/services/escalations.js";

/**
 * The Escalation column on Daily Records.
 *
 * Whether somebody is escalated depends on their whole Monday-to-Sunday week,
 * but a Daily Records page shows only the range it is filtered to. So the
 * server counts the whole week for every instructor on the page, and these
 * tests hold it to that - and to the same counting the URGENT email uses.
 */

function matches(doc, filter = {}) {
  for (const [key, condition] of Object.entries(filter)) {
    const value = doc[key];
    const isOperator = condition && typeof condition === "object" && !Array.isArray(condition)
      && Object.keys(condition).some((k) => k.startsWith("$"));
    if (!isOperator) {
      if (String(value) !== String(condition)) return false;
      continue;
    }
    for (const [op, arg] of Object.entries(condition)) {
      if (op === "$in" && !arg.some((item) => String(item) === String(value))) return false;
      if (op === "$exists" && (value !== undefined) !== arg) return false;
    }
  }
  return true;
}

function memoryDb(attendance) {
  const queries = [];
  return {
    queries,
    collection() {
      return {
        find(filter) {
          queries.push(filter);
          const rows = attendance.filter((doc) => matches(doc, filter));
          return { toArray: async () => rows };
        },
      };
    },
  };
}

const row = (id, instructor, day, extra = {}) => ({
  _id: id,
  instructor_id: instructor,
  college_id: "niat",
  attendance_day: day,
  check_in_time: `${day}T04:00:00Z`,
  status: "compliant",
  ...extra,
});

const WEEK = [
  row("mon", "i1", "2026-09-21", { status: "non_compliant" }),
  row("tue", "i1", "2026-09-22", { checkout_compliance_status: "NON_COMPLIANT", check_out_time: "2026-09-22T12:00:00Z" }),
  row("fri", "i1", "2026-09-25", { status: "non_compliant" }),
  row("fri2", "i2", "2026-09-25", { status: "non_compliant" }),
];

test("a page showing only today still counts the rest of the week", async () => {
  const db = memoryDb(WEEK);
  const todayOnly = [WEEK[2], WEEK[3]];
  const escalations = await weeklyEscalations(db, todayOnly);

  assert.deepEqual(escalationFor(escalations, WEEK[2]), {
    week_start: "2026-09-21",
    week_end: "2026-09-27",
    count: 3,
  });
  assert.equal(escalationFor(escalations, WEEK[3]), null, "one failure is not an escalation");
  assert.equal(db.queries.length, 1, "one query for the whole page");
});

test("every row of an escalated instructor that week is marked, compliant ones too", async () => {
  const escalations = await weeklyEscalations(memoryDb(WEEK), WEEK);
  for (const id of ["mon", "tue", "fri"]) {
    assert.equal(escalationFor(escalations, WEEK.find((r) => r._id === id)).count, 3, id);
  }
});

test("each week is counted on its own", async () => {
  const twoWeeks = [
    row("lastSat", "i1", "2026-09-19", { status: "non_compliant" }),
    row("lastSun", "i1", "2026-09-20", { status: "non_compliant" }),
    row("mon", "i1", "2026-09-21", { status: "non_compliant" }),
  ];
  const escalations = await weeklyEscalations(memoryDb(twoWeeks), twoWeeks);
  assert.equal(escalations.size, 0, "two last week and one this week escalates neither");
});

test("a campus sees only its own records counted", async () => {
  const mixed = [
    row("a", "i1", "2026-09-21", { status: "non_compliant", college_id: "other" }),
    row("b", "i1", "2026-09-22", { status: "non_compliant", college_id: "other" }),
    row("c", "i1", "2026-09-25", { status: "non_compliant" }),
  ];
  const db = memoryDb(mixed);
  const scoped = await weeklyEscalations(db, [mixed[2]], { college_id: "niat" });
  assert.equal(scoped.size, 0);
  assert.equal(db.queries[0].college_id, "niat", "the list's own scope is applied to the count");
});

test("unidentified rows and rows without a day are never escalated", async () => {
  const unidentified = [row("u", null, "2026-09-25", { status: "unidentified" }), { _id: "x", instructor_id: "i1" }];
  const db = memoryDb(unidentified);
  const escalations = await weeklyEscalations(db, unidentified);
  assert.equal(escalations.size, 0);
  assert.equal(db.queries.length, 0, "nothing to count, so nothing is queried");
  assert.equal(escalationFor(escalations, unidentified[0]), null);
});

test("Daily Records rows carry their escalation", async () => {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  const route = source.slice(source.indexOf('"/today"'), source.indexOf("attendanceRouter.get(", source.indexOf('"/today"')));
  assert.match(route, /weeklyEscalations\(db, attendances, attendanceScope\(req\.currentUser\)\)/);
  assert.match(route, /escalation: escalationFor\(escalations, attendance\)/);
});
