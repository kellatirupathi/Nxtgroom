import { dateBoundsInTimeZone, dateRangeBoundsInTimeZone } from "../src/utils.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app } from "../server.js";
import { createAccessToken } from "../src/middleware/auth.js";

let server;
let baseUrl;

before(async () => {
  process.env.APP_TIME_ZONE = "Asia/Kolkata";
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("attendance date query is strict, timezone-aware, scoped, and includes college name", async () => {
  let attendanceQuery;
  let attendanceFinds = 0;
  let attendanceSort;
  let attendanceOffset;
  let attendanceLimit;
  const attendanceCursor = {
    project() { return this; },
    sort(specification) { attendanceSort = specification; return this; },
    skip(value) { attendanceOffset = value; return this; },
    limit(value) { attendanceLimit = value; return this; },
    async toArray() {
      return [{
        _id: "attendance-date-1",
        instructor_id: "instructor-date-1",
        instructor_name: "Date Instructor",
        instructor_role: "Trainee",
        college_id: "college-date-1",
        date: new Date("2026-08-14T03:30:00.000Z"),
        check_in_time: new Date("2026-08-14T03:30:00.000Z"),
        status: "compliant",
        _private_evaluation_outbox: { image: Buffer.from("private") },
        _private_attendance_guard_version: 8,
      }];
    },
  };
  app.locals.db = {
    collection(name) {
      if (name === "users") return {
        findOne: async ({ email }) => ({
          email,
          role: "SUPER_ADMIN",
          session_version: 0,
        }),
      };
      if (name === "attendance") return {
        find(query) {
          attendanceFinds += 1;
          attendanceQuery = query;
          return attendanceCursor;
        },
      };
      if (name === "colleges") return {
        find: () => ({
          toArray: async () => [{ _id: "college-date-1", name: "Date College" }],
        }),
      };
      // Every row is looked up now, for the report token the table links with.
      if (name === "instructors") return {
        find: () => ({
          toArray: async () => [{
            _id: "instructor-date-1",
            name: "Date Instructor",
            report_token: "token-date-1",
          }],
        }),
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };
  const token = createAccessToken({ sub: "admin@example.com", role: "SUPER_ADMIN" });
  const response = await fetch(
    `${baseUrl}/api/v2/attendance/today?date=2026-08-14&limit=1000&offset=1000000`,
    {
    headers: { authorization: `Bearer ${token}`, connection: "close" },
    }
  );
  assert.equal(response.status, 200);
  assert.equal(attendanceQuery.date.$gte.toISOString(), "2026-08-13T18:30:00.000Z");
  assert.equal(attendanceQuery.date.$lt.toISOString(), "2026-08-14T18:30:00.000Z");
  assert.deepEqual(attendanceSort, { check_in_time: -1, _id: -1 });
  assert.equal(attendanceOffset, 1_000_000);
  assert.equal(attendanceLimit, 1000);
  const rows = await response.json();
  assert.equal(rows[0].college_name, "Date College");
  // Carried so the records table can link to the same public report the
  // instructor receives by email, rather than a second view of it.
  assert.equal(rows[0].report_token, "token-date-1");
  assert.equal(rows[0]._private_evaluation_outbox, undefined);
  assert.equal(rows[0]._private_attendance_guard_version, undefined);

  const invalid = await fetch(`${baseUrl}/api/v2/attendance/today?date=2026-02-30`, {
    headers: { authorization: `Bearer ${token}`, connection: "close" },
  });
  assert.equal(invalid.status, 422);
  assert.match((await invalid.json()).detail, /real calendar date/);

  const repeated = await fetch(
    `${baseUrl}/api/v2/attendance/today?date=2026-08-14&date=2026-08-15`,
    { headers: { authorization: `Bearer ${token}`, connection: "close" } }
  );
  assert.equal(repeated.status, 422);

  for (const query of [
    "limit=0",
    "limit=1001",
    "limit=01",
    "limit=1.5",
    "limit=1&limit=2",
    "offset=-1",
    "offset=1000001",
    "offset=01",
    "offset=0&offset=1",
  ]) {
    const invalidPage = await fetch(`${baseUrl}/api/v2/attendance/today?${query}`, {
      headers: { authorization: `Bearer ${token}`, connection: "close" },
    });
    assert.equal(invalidPage.status, 422, query);
  }
  assert.equal(attendanceFinds, 1);
});

test("a date range covers whole local days at both ends", () => {
  const zone = "Asia/Kolkata";
  const { start, end } = dateRangeBoundsInTimeZone("2026-08-10", "2026-08-12", zone);
  // Local midnight in Asia/Kolkata is 18:30 UTC the previous day.
  assert.equal(start.toISOString(), "2026-08-09T18:30:00.000Z");
  // The final day is included in full: the bound is midnight after the 12th,
  // not midnight starting it, so a 23:00 check-in on the 12th is inside.
  assert.equal(end.toISOString(), "2026-08-12T18:30:00.000Z");
});

test("a single-day range still contains that day", () => {
  const { start, end } = dateRangeBoundsInTimeZone("2026-08-18", "2026-08-18", "Asia/Kolkata");
  assert.ok(start < end);
  assert.equal(end - start, 24 * 60 * 60 * 1000);
});

test("either end of a range may be left open", () => {
  const openEnded = dateRangeBoundsInTimeZone("2026-08-01", undefined, "Asia/Kolkata");
  assert.ok(openEnded.start instanceof Date);
  assert.equal(openEnded.end, null);

  const openStart = dateRangeBoundsInTimeZone(undefined, "2026-08-01", "Asia/Kolkata");
  assert.equal(openStart.start, null);
  assert.ok(openStart.end instanceof Date);

  // Both open is what "all time" asks for, and must not throw.
  assert.deepEqual(dateRangeBoundsInTimeZone(undefined, undefined, "Asia/Kolkata"), {
    start: null,
    end: null,
  });
});

test("a backwards range is refused rather than returning nothing", () => {
  // Silently returning an empty table would read as "no records exist", which
  // is a different thing from "these dates are the wrong way round".
  assert.throws(
    () => dateRangeBoundsInTimeZone("2026-08-20", "2026-08-10", "Asia/Kolkata"),
    RangeError
  );
  assert.throws(
    () => dateRangeBoundsInTimeZone(["2026-08-01"], undefined, "Asia/Kolkata"),
    RangeError
  );
  assert.throws(
    () => dateRangeBoundsInTimeZone("18-08-2026", undefined, "Asia/Kolkata"),
    RangeError
  );
});

test("the role snapshot prefers the field imported instructors actually carry", () => {
  // An instructor from BigQuery has instructor_role and no role at all.
  // Snapshotting `role` alone recorded null for 599 of 600 people, and lost
  // the distinction between an INSTRUCTOR and a CENTRAL_INSTRUCTOR.
  const snapshot = (instructor) => instructor.instructor_role || instructor.role || null;

  assert.equal(snapshot({ instructor_role: "CENTRAL_INSTRUCTOR" }), "CENTRAL_INSTRUCTOR");
  // A hand-added instructor has role and no instructor_role.
  assert.equal(snapshot({ role: "INSTRUCTOR" }), "INSTRUCTOR");
  // Both present: the warehouse value wins, since a sync refreshes it.
  assert.equal(snapshot({ instructor_role: "CENTRAL_INSTRUCTOR", role: "INSTRUCTOR" }), "CENTRAL_INSTRUCTOR");
  assert.equal(snapshot({}), null);
});

test("a role missing from an older record falls back to the instructor", () => {
  // Records written before the snapshot was fixed carry no role. Reading it
  // back from the instructor is what stops them showing "Unknown" forever.
  const resolve = (attendance, instructor) => attendance.instructor_role
    || instructor?.instructor_role
    || instructor?.role
    || "Unknown";

  assert.equal(resolve({ instructor_role: null }, { instructor_role: "CENTRAL_INSTRUCTOR" }), "CENTRAL_INSTRUCTOR");
  assert.equal(resolve({ instructor_role: "INSTRUCTOR" }, { instructor_role: "CENTRAL_INSTRUCTOR" }),
    "INSTRUCTOR", "the snapshot wins, so a report shows the role held on the day");
  assert.equal(resolve({}, null), "Unknown");
});

test("an unclosed check-in only blocks the day it belongs to", () => {
  // The guard matched any open check-in ever, so one missed check-out on
  // Monday stopped that instructor checking in for the rest of time. A day is
  // a local calendar day: yesterday's open record is a missed check-out to
  // chase, not a reason to refuse today.
  const { start, end } = dateBoundsInTimeZone("2026-08-19", "Asia/Kolkata");
  const blocksToday = (checkInIso) => {
    const at = new Date(checkInIso);
    return at >= start && at < end;
  };

  // The record that was actually blocking check-ins: 18 August, never closed.
  assert.equal(blocksToday("2026-08-18T13:15:00.000Z"), false, "yesterday must not block today");
  // Anything inside today still blocks, which is the rule the guard is for.
  assert.equal(blocksToday("2026-08-19T04:00:00.000Z"), true);
  assert.equal(blocksToday("2026-08-19T18:29:00.000Z"), true, "23:59 local is still today");
  // Local midnight in Asia/Kolkata is 18:30 UTC the day before, so a check-in
  // just after it belongs to today rather than to yesterday in UTC.
  assert.equal(blocksToday("2026-08-18T18:31:00.000Z"), true, "00:01 local today");
  assert.equal(blocksToday("2026-08-18T18:29:00.000Z"), false, "23:59 local yesterday");
});

test("an instructor with no address is distinguishable from one you cannot see", () => {
  // A BOA is not shown contact details. Reporting that as "no email on record"
  // told administrators an instructor could not be emailed a report when they
  // could, and the check-in itself would have worked.
  const describe = (instructor) => {
    if (instructor.email) return instructor.email;
    if (instructor.has_email) return instructor.role || "Instructor";
    return "No email on record";
  };

  assert.equal(describe({ email: "a@nxtwave.co.in", has_email: true }), "a@nxtwave.co.in");
  assert.equal(describe({ has_email: true, role: "CENTRAL_INSTRUCTOR" }), "CENTRAL_INSTRUCTOR");
  assert.equal(describe({ has_email: false }), "No email on record");
  // Records fetched before has_email existed carry neither, and must still
  // read as absent rather than crashing.
  assert.equal(describe({}), "No email on record");
});

test("a half with no evaluation is an empty answer, not an error", () => {
  // 404 made the detail page paint a red error box for the ordinary cases:
  // no check-out photo was taken, or the analysis has not finished yet.
  // Neither is a failure, and neither should look like one.
  const respond = (evaluation) => (evaluation ? { status: 200, body: evaluation } : { status: 204 });

  assert.equal(respond(null).status, 204);
  assert.equal(respond(null).body, undefined, "204 carries no body");
  assert.equal(respond({ overall_status: "COMPLIANT" }).status, 200);
});

test("the check-out tab reads its own verdict, never the check-in's", () => {
  // The badge showed record.status on both tabs, so a check-out could be
  // labelled with the morning's result — or "Not assessed" when only the
  // check-in was.
  const badgeFor = (tab, record) => (tab === "checkout"
    ? (record.checkout_compliance_status
      ? String(record.checkout_compliance_status).toLowerCase()
      : (record.check_out_photo_key ? "pending" : undefined))
    : record.status);

  const record = {
    status: "unassessed",
    checkout_compliance_status: "COMPLIANT",
    check_out_photo_key: "k",
  };
  assert.equal(badgeFor("checkin", record), "unassessed");
  assert.equal(badgeFor("checkout", record), "compliant");

  // A check-out photo with no verdict yet is pending, not the check-in's.
  assert.equal(badgeFor("checkout", { status: "non_compliant", check_out_photo_key: "k" }), "pending");
  // No photo at all means there is no verdict to show and never will be.
  assert.equal(badgeFor("checkout", { status: "non_compliant" }), undefined);
});
