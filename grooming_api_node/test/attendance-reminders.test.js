import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  deliverAttendanceReminders,
  deliverCheckinReminders,
  dueAttendanceReminders,
  getAttendanceReminderSettings,
  runDueAttendanceReminders,
  saveAttendanceReminderSettings,
  validateAttendanceReminders,
} from "../src/services/attendanceReminders.js";
import { buildAttendanceReminderEmail } from "../src/services/emailService.js";

const MONDAY = Date.UTC(2026, 9, 4, 18, 30);
const ist = (hour, minute = 0, dayOffset = 0) => new Date(MONDAY + ((dayOffset * 24 + hour) * 60 + minute) * 60_000);
const valueOf = (value) => (value instanceof Date ? value.getTime() : value);
const same = (left, right) => String(valueOf(left)) === String(valueOf(right));

function matches(doc, filter = {}) {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === "$or") {
      if (!condition.some((branch) => matches(doc, branch))) return false;
      continue;
    }
    const value = doc[key];
    const isOperator = condition && typeof condition === "object" && !(condition instanceof Date)
      && !Array.isArray(condition) && Object.keys(condition).some((k) => k.startsWith("$"));
    if (!isOperator) {
      if (condition === null ? value !== null && value !== undefined : !same(value, condition)) return false;
      continue;
    }
    for (const [op, arg] of Object.entries(condition)) {
      if (op === "$gte" && !(value != null && valueOf(value) >= valueOf(arg))) return false;
      if (op === "$lt" && !(value != null && valueOf(value) < valueOf(arg))) return false;
      if (op === "$lte" && !(value != null && valueOf(value) <= valueOf(arg))) return false;
      if (op === "$in" && !arg.some((item) => same(item, value))) return false;
      if (op === "$nin" && arg.some((item) => (item === null ? value == null : same(item, value)))) return false;
      if (op === "$exists" && (value !== undefined) !== arg) return false;
    }
  }
  return true;
}

function memoryDb(seed = {}) {
  const collections = new Map(Object.entries(seed).map(([name, docs]) => [name, docs.map((doc) => ({ ...doc }))]));
  const docs = (name) => {
    if (!collections.has(name)) collections.set(name, []);
    return collections.get(name);
  };
  return {
    docs,
    collection(name) {
      return {
        find(filter = {}) {
          const rows = docs(name).filter((doc) => matches(doc, filter));
          return { toArray: async () => rows.map((row) => ({ ...row })) };
        },
        async findOne(filter = {}) {
          const found = docs(name).find((doc) => matches(doc, filter));
          return found ? { ...found } : null;
        },
        async distinct(field, filter = {}) {
          return [...new Set(docs(name).filter((doc) => matches(doc, filter)).map((doc) => doc[field]))];
        },
        async updateOne(filter, update, options = {}) {
          const found = docs(name).find((doc) => matches(doc, filter));
          if (found) {
            Object.assign(found, update.$set || {});
            return { matchedCount: 1 };
          }
          if (!options.upsert) return { matchedCount: 0 };
          docs(name).push({ _id: filter._id, ...(update.$setOnInsert || {}), ...(update.$set || {}) });
          return { matchedCount: 0, upsertedCount: 1 };
        },
        async findOneAndUpdate(filter, update) {
          const found = docs(name).find((doc) => matches(doc, filter));
          if (!found) return null;
          for (const [field, amount] of Object.entries(update.$inc || {})) found[field] = (found[field] || 0) + amount;
          Object.assign(found, update.$set || {});
          return { ...found };
        },
      };
    },
  };
}

const instructors = [
  { _id: "i-ravi", name: "Ravi", email: "ravi@nxtwave.co.in" },
  { _id: "i-asha", name: "Asha", email: "asha@nxtwave.co.in" },
  { _id: "i-kiran", name: "Kiran", email: "kiran@nxtwave.co.in" },
  { _id: "i-noemail", name: "No Mail", email: "" },
  { _id: "i-gone", name: "Gone", email: "gone@nxtwave.co.in", deleted_at: ist(0, 0, -3) },
];
const attendance = [
  { _id: "a-ravi", instructor_id: "i-ravi", instructor_name: "Ravi", date: ist(9, 10), check_in_time: ist(9, 10), check_out_time: null },
  { _id: "a-asha", instructor_id: "i-asha", instructor_name: "Asha", date: ist(9, 20), check_in_time: ist(9, 20), check_out_time: ist(17, 0) },
];
const fixture = (settings) => memoryDb({
  instructors,
  attendance,
  ...(settings ? { app_settings: [{ _id: "attendance_reminder_settings", ...settings }] } : {}),
});

test("both missed-attendance emails are off, with no time, until set", async () => {
  const db = fixture();
  const settings = await getAttendanceReminderSettings(db);
  assert.deepEqual(
    { ...settings, checkin_changed_at: undefined, checkout_changed_at: undefined },
    {
      checkin_reminder_enabled: false,
      checkin_reminder_time: "",
      checkout_reminder_enabled: false,
      checkout_reminder_time: "",
      checkin_changed_at: undefined,
      checkout_changed_at: undefined,
    }
  );
  assert.deepEqual(dueAttendanceReminders(settings, ist(19, 0)), []);
  assert.deepEqual(await runDueAttendanceReminders(db, ist(19, 0)), []);
  assert.equal(db.docs("mail_jobs").length, 0);
});

test("only the two switches and HH:MM times are accepted", () => {
  assert.equal(validateAttendanceReminders({ checkin_reminder_enabled: true, checkin_reminder_time: "10:30" }).valid, true);
  assert.equal(validateAttendanceReminders({ checkout_reminder_time: "" }).valid, true);
  assert.equal(validateAttendanceReminders({ checkout_reminder_time: "7 PM" }).valid, false);
  assert.equal(validateAttendanceReminders({ checkout_reminder_enabled: "yes" }).valid, false);
  assert.equal(validateAttendanceReminders({ weekly: true }).valid, false);
  assert.equal(validateAttendanceReminders([]).valid, false);
});

test("each email goes at its own saved time; a time already past when saved starts tomorrow", async () => {
  const db = fixture();
  await saveAttendanceReminderSettings(db, { checkin_reminder_enabled: true, checkin_reminder_time: "10:30" }, "admin@x", ist(8, 0));
  await saveAttendanceReminderSettings(db, { checkout_reminder_enabled: true, checkout_reminder_time: "19:00" }, "admin@x", ist(8, 0));
  const settings = await getAttendanceReminderSettings(db);
  assert.deepEqual(dueAttendanceReminders(settings, ist(10, 29)), []);
  assert.deepEqual(dueAttendanceReminders(settings, ist(10, 30)).map((due) => due.kind), ["checkin"]);
  assert.deepEqual(dueAttendanceReminders(settings, ist(19, 5)).map((due) => due.kind), ["checkout"]);
  assert.deepEqual(dueAttendanceReminders(settings, ist(13, 0)), [], "more than two hours late is skipped");

  await saveAttendanceReminderSettings(db, { checkin_reminder_time: "09:00" }, "admin@x", ist(9, 30));
  const moved = await getAttendanceReminderSettings(db);
  assert.deepEqual(dueAttendanceReminders(moved, ist(9, 45)), [], "9:00 had passed when it was saved");
  assert.deepEqual(dueAttendanceReminders(moved, ist(9, 0, 1)).map((due) => due.kind), ["checkin"], "so it starts tomorrow");
  assert.equal(db.docs("app_settings")[0].updated_by, "admin@x");
});

test("the check-in email skips Sundays", async () => {
  const settings = { checkin_reminder_enabled: true, checkin_reminder_time: "10:30", checkout_reminder_enabled: true, checkout_reminder_time: "19:00" };
  assert.deepEqual(dueAttendanceReminders(settings, ist(10, 35, 6)), [], "Sunday morning");
  assert.deepEqual(dueAttendanceReminders(settings, ist(19, 5, 6)).map((due) => due.kind), ["checkout"]);
});

test("the check-in email goes to active instructors with an email who have not checked in", async () => {
  const db = fixture();
  const result = await deliverCheckinReminders(db, ist(10, 30));
  assert.equal(result.queued, 1);
  const [job] = db.docs("mail_jobs");
  assert.equal(job._id, "checkin-reminders:2026-10-05:i-kiran");
  assert.equal(job.type, "checkin_reminder");
  assert.equal(job.to_email, "kiran@nxtwave.co.in");
  assert.deepEqual(job.payload, { name: "Kiran", kind: "checkin", dateLabel: "2026-10-05", date: "2026-10-05", instructor_id: "i-kiran" });
  const run = db.docs("report_delivery_runs").find((doc) => doc._id === "checkin-reminders:2026-10-05");
  assert.equal(run.type, "checkin_reminder");
  assert.equal(run.queued, 1);
  assert.ok(run.production_finished_at);
});

test("the check-out email goes to those who checked in and have not checked out", async () => {
  const db = fixture();
  const result = await deliverAttendanceReminders(db, ist(19, 0));
  assert.equal(result.queued, 1);
  const [job] = db.docs("mail_jobs");
  assert.equal(job._id, "attendance-reminders:2026-10-05:a-ravi");
  assert.equal(job.type, "attendance_reminder");
  assert.equal(job.payload.kind, "checkout");
  assert.equal(job.to_email, "ravi@nxtwave.co.in");
});

test("switched on, each email is sent once a day at its time", async () => {
  const db = fixture({
    checkin_reminder_enabled: true,
    checkin_reminder_time: "10:30",
    checkout_reminder_enabled: true,
    checkout_reminder_time: "19:00",
    checkin_changed_at: ist(8, 0),
    checkout_changed_at: ist(8, 0),
  });
  assert.deepEqual(await runDueAttendanceReminders(db, ist(10, 0)), []);
  assert.deepEqual(await runDueAttendanceReminders(db, ist(10, 30)), ["checkin-reminders:2026-10-05"]);
  assert.deepEqual(await runDueAttendanceReminders(db, ist(10, 31)), [], "not twice, even after a restart");
  assert.deepEqual(await runDueAttendanceReminders(db, ist(19, 0)), ["attendance-reminders:2026-10-05"]);
  assert.deepEqual(db.docs("mail_jobs").map((job) => job.type).sort(), ["attendance_reminder", "checkin_reminder"]);
  assert.deepEqual(await runDueAttendanceReminders(db, ist(10, 30, 1)), ["checkin-reminders:2026-10-06"], "and again the next day");
});

test("switched off, nothing goes even at the time", async () => {
  const db = fixture({ checkin_reminder_enabled: false, checkin_reminder_time: "10:30", checkout_reminder_enabled: false, checkout_reminder_time: "19:00" });
  assert.deepEqual(await runDueAttendanceReminders(db, ist(10, 30)), []);
  assert.deepEqual(await runDueAttendanceReminders(db, ist(19, 0)), []);
  assert.equal(db.docs("mail_jobs").length, 0);
});

test("the check-in email asks them to check in", () => {
  const email = buildAttendanceReminderEmail({ name: "Kiran", kind: "checkin", dateLabel: "2026-10-05" });
  assert.equal(email.subject, "Reminder: check-in missing for 2026-10-05");
  assert.match(email.text, /We have not received a check-in from you today \(2026-10-05\)\./);
  const checkout = buildAttendanceReminderEmail({ name: "Ravi", kind: "checkout", dateLabel: "2026-10-05" });
  assert.equal(checkout.subject, "Reminder: check-out missing for 2026-10-05");
});

test("Settings serves the switches, the scheduler runs, the cron call obeys the switch, and a late check-in cancels the email", async () => {
  const admin = (await readFile(new URL("../src/routes/adminRoutes.js", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  assert.ok(admin.includes('adminRouter.get(\n  "/settings/attendance-reminders",\n  requireSuperAdmin'));
  assert.ok(admin.includes('adminRouter.put(\n  "/settings/attendance-reminders",\n  requireSuperAdmin'));
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /startDailyReportScheduler\(db\),\s*startAttendanceReminderScheduler\(db\),/);
  const reports = await readFile(new URL("../src/routes/reportRoutes.js", import.meta.url), "utf8");
  assert.match(reports, /const \{ checkout_reminder_enabled: enabled \} = await getAttendanceReminderSettings\(db\);\s*if \(!enabled\) \{/);
  const mail = await readFile(new URL("../src/services/mailWorker.js", import.meta.url), "utf8");
  assert.match(mail, /"checkin_reminder",/);
  assert.match(mail, /if \(job\.type === "checkin_reminder" && await checkedInSinceQueued\(db, job\.payload\)\) \{/);
});
