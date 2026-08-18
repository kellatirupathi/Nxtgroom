import { dateRangeBoundsInTimeZone } from "../src/utils.js";
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
