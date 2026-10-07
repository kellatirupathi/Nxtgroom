import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { addHoliday, clearHolidayCache, holidayDates, listHolidays, removeHoliday } from "../src/services/holidays.js";
import { failedDayStreaks } from "../src/services/evaluationWorker.js";
import { auditQuery, describeRequest, listAuditLog, recordAudit } from "../src/services/auditLog.js";

function settingsDb() {
  const docs = new Map();
  return {
    docs,
    collection(name) {
      assert.equal(name, "app_settings");
      return {
        findOne: async ({ _id }) => docs.get(_id) || null,
        updateOne: async ({ _id }, update) => {
          docs.set(_id, { ...(docs.get(_id) || update.$setOnInsert || {}), ...update.$set });
          return { matchedCount: 1 };
        },
      };
    },
  };
}

test("holidays are added once per date, sorted, and removed", async () => {
  clearHolidayCache();
  const db = settingsDb();
  assert.deepEqual(await listHolidays(db), []);
  assert.equal((await addHoliday(db, { date: "2026-10-20", name: " Diwali " }, "admin@x")).ok, true);
  assert.equal((await addHoliday(db, { date: "2026-10-02", name: "Gandhi Jayanti" })).ok, true);
  assert.equal((await addHoliday(db, { date: "2026-10-20", name: "Again" })).ok, false, "one per date");
  assert.equal((await addHoliday(db, { date: "20-10-2026", name: "x" })).ok, false);
  assert.equal((await addHoliday(db, { date: "2026-10-21", name: "" })).ok, false);
  assert.deepEqual((await listHolidays(db)).map((h) => `${h.date} ${h.name}`), ["2026-10-02 Gandhi Jayanti", "2026-10-20 Diwali"]);
  assert.ok((await holidayDates(db)).has("2026-10-20"));
  assert.equal((await removeHoliday(db, "2026-10-02")).ok, true);
  assert.equal((await removeHoliday(db, "2026-10-02")).ok, false);
  assert.equal(db.docs.get("holiday_settings").updated_by, null);
  clearHolidayCache();
});

test("a holiday is skipped in a run of failed days: it neither counts nor breaks the run", () => {
  const day = (date, status) => ({ attendance_day: date, check_in_time: `${date}T04:00:00.000Z`, status });
  const records = [day("2026-10-05", "non_compliant"), day("2026-10-06", "non_compliant"), day("2026-10-07", "non_compliant")];
  assert.equal(failedDayStreaks(records, "2026-10-05")[0].length, 3, "three in a row is an escalation");
  assert.equal(failedDayStreaks(records, "2026-10-05", new Set(["2026-10-06"]))[0].length, 2, "the holiday's result does not count");
});

test("only admin changes are logged, described in plain words", () => {
  assert.deepEqual(describeRequest("PUT", "/api/v2/settings/notifications"), { action: "Changed settings: notifications", category: "settings" });
  assert.deepEqual(describeRequest("DELETE", "/api/v2/instructors/abc123"), { action: "Deleted instructor", category: "delete" });
  assert.deepEqual(describeRequest("POST", "/api/v2/instructors"), { action: "Created instructor", category: "create" });
  assert.deepEqual(describeRequest("PUT", "/api/v2/colleges/c1"), { action: "Updated institute", category: "edit" });
  assert.deepEqual(describeRequest("POST", "/api/v2/boas/b1/password"), { action: "Set BOA password", category: "edit" });
  assert.deepEqual(describeRequest("POST", "/api/v2/attendance/bulk-delete"), { action: "Created attendance records (bulk)", category: "delete" });
  assert.equal(describeRequest("POST", "/api/v2/attendance/auto"), null, "kiosk check-ins are not admin changes");
  assert.equal(describeRequest("POST", "/api/v2/attendance/check-in"), null);
  assert.equal(describeRequest("POST", "/api/v2/auth/login"), null, "logins are logged by the login route itself");
});

test("the log is written without passwords and read newest first with filters", async () => {
  const rows = [];
  const db = {
    collection(name) {
      assert.equal(name, "audit_logs");
      return {
        createIndex: async () => "at_-1",
        insertOne: async (doc) => { rows.push({ _id: rows.length + 1, ...doc }); },
        find: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ toArray: async () => [...rows].reverse() }) }) }) }),
        countDocuments: async () => rows.length,
      };
    },
  };
  await recordAudit(db, { actor_email: "admin@x", action: "Logged in (password)", category: "login" });
  const result = await listAuditLog(db, {});
  assert.equal(result.total, 1);
  assert.equal(result.entries[0].actor_email, "admin@x");
  assert.ok(result.entries[0].at instanceof Date);
  const filter = auditQuery({ q: "admin", category: "login", from: "2026-10-01", to: "2026-10-06" });
  assert.equal(filter.category, "login");
  assert.ok(filter.at.$gte < filter.at.$lt);
  assert.equal(filter.$or.length, 4);
  assert.deepEqual(auditQuery({ category: "nope" }), {});
});

test("the audit log, holidays, logins and reminders are wired in", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /app\.use\("\/api\/v2", auditTrail\);\s*app\.use\("\/api\/v2\/auth\/login", loginLimiter\);/);
  const auth = await readFile(new URL("../src/routes/authRoutes.js", import.meta.url), "utf8");
  for (const action of ["Failed login (password)", "Logged in (password)", "Failed login (Google)", "Logged in (Google)"]) {
    assert.ok(auth.includes(action), action);
  }
  const admin = (await readFile(new URL("../src/routes/adminRoutes.js", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  assert.ok(admin.includes('adminRouter.get(\n  "/settings/audit-log",\n  requireRootAdmin,'), "super admin only");
  assert.ok(admin.includes('adminRouter.post(\n  "/settings/holidays",\n  requireSuperAdmin,'));
  const reminders = await readFile(new URL("../src/services/attendanceReminders.js", import.meta.url), "utf8");
  assert.match(reminders, /if \(await isHoliday\(db, due\.dateKey\)\) \{/);
  const worker = await readFile(new URL("../src/services/evaluationWorker.js", import.meta.url), "utf8");
  assert.match(worker, /const holidays = await holidayDates\(db\);\s*if \(holidays\.has\(dayKey\)\) return 0;/, "no escalation emails on a holiday");
});
