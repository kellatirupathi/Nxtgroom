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
