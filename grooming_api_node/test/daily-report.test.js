import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

process.env.CORS_ORIGINS = process.env.CORS_ORIGINS || "https://nxtgroom-xi.vercel.app";
process.env.APP_URL = "https://nxtgroom-xi.vercel.app";

const {
  addDailyReportRecipient,
  buildDailyReport,
  buildDailyReportForEmail,
  buildFullDayReport,
  dailyReportDayPath,
  dailyReportDays,
  dailyReportPhotoKey,
  dayCountsPipeline,
  dailyReportSubject,
  dueDailyReports,
  ensureDailyReportDay,
  findDailyReportDay,
  getDailyReportSettings,
  normaliseTimes,
  parseDateSegment,
  removeDailyReportRecipient,
  saveDailyReportSchedule,
  slotLabel,
} = await import("../src/services/dailyReport.js");
const { runDueDailyReports } = await import("../src/services/dailyReportScheduler.js");
const { buildDailyReportEmail } = await import("../src/services/emailService.js");

/**
 * The daily report: settings, which period each send covers, who is in it,
 * the email, sending exactly once, and the public link.
 */

// 30 Sep 2026 in Asia/Kolkata (UTC+5:30): local midnight is 29 Sep 18:30 UTC.
const MIDNIGHT = Date.UTC(2026, 8, 29, 18, 30);
const ist = (hour, minute = 0, dayOffset = 0) => new Date(MIDNIGHT + ((dayOffset * 24 + hour) * 60 + minute) * 60_000);

// -- A small in-memory MongoDB -------------------------------------------------

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
      if (op === "$gt" && !(value != null && valueOf(value) > valueOf(arg))) return false;
      if (op === "$lt" && !(value != null && valueOf(value) < valueOf(arg))) return false;
      if (op === "$lte" && !(value != null && valueOf(value) <= valueOf(arg))) return false;
      if (op === "$in" && !arg.some((item) => same(item, value))) return false;
      if (op === "$nin" && arg.some((item) => (item === null ? value == null : same(item, value)))) return false;
      if (op === "$ne" && same(value, arg)) return false;
      if (op === "$exists" && (value !== undefined) !== arg) return false;
    }
  }
  return true;
}

function applyUpdate(doc, update, inserting) {
  Object.assign(doc, update.$set || {});
  if (inserting) Object.assign(doc, update.$setOnInsert || {});
  for (const [field, amount] of Object.entries(update.$inc || {})) doc[field] = (doc[field] || 0) + amount;
  for (const [field, value] of Object.entries(update.$addToSet || {})) {
    doc[field] = Array.isArray(doc[field]) ? doc[field] : [];
    if (!doc[field].includes(value)) doc[field].push(value);
  }
  for (const [field, value] of Object.entries(update.$pull || {})) {
    doc[field] = (doc[field] || []).filter((item) => item !== value);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Just enough of the aggregation language for the day counts. */
function evaluate(expression, doc) {
  if (typeof expression === "string" && expression.startsWith("$")) return doc[expression.slice(1)];
  if (!expression || typeof expression !== "object") return expression;
  if ("$dateToString" in expression) {
    const { date, timezone } = expression.$dateToString;
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(evaluate(date, doc));
  }
  if ("$cond" in expression) {
    const [condition, then, otherwise] = expression.$cond;
    return evaluate(condition, doc) ? evaluate(then, doc) : evaluate(otherwise, doc);
  }
  if ("$and" in expression) return expression.$and.every((part) => evaluate(part, doc));
  if ("$not" in expression) return !evaluate(expression.$not[0], doc);
  if ("$gt" in expression) {
    const [left, right] = expression.$gt.map((part) => evaluate(part, doc));
    return left !== undefined && left !== null && (right === null || valueOf(left) > valueOf(right));
  }
  throw new Error(`unsupported expression ${JSON.stringify(expression)}`);
}

function runPipeline(docs, pipeline) {
  let rows = docs;
  for (const stage of pipeline) {
    if (stage.$match) rows = rows.filter((doc) => matches(doc, stage.$match));
    if (stage.$group) {
      const groups = new Map();
      for (const doc of rows) {
        const key = evaluate(stage.$group._id, doc);
        const group = groups.get(key) || { _id: key };
        for (const [field, spec] of Object.entries(stage.$group)) {
          if (field === "_id") continue;
          group[field] = (group[field] || 0) + Number(evaluate(spec.$sum, doc));
        }
        groups.set(key, group);
      }
      rows = [...groups.values()];
    }
  }
  return rows;
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
          let rows = docs(name).filter((doc) => matches(doc, filter));
          const cursor = {
            sort(spec) {
              const [[field, direction]] = Object.entries(spec);
              rows = [...rows].sort((a, b) => (valueOf(a[field]) - valueOf(b[field])) * direction);
              return cursor;
            },
            limit(count) { rows = rows.slice(0, count); return cursor; },
            project() { return cursor; },
            toArray: async () => rows.map((row) => ({ ...row })),
          };
          return cursor;
        },
        async findOne(filter = {}) {
          const found = docs(name).find((doc) => matches(doc, filter));
          return found ? { ...found } : null;
        },
        async updateOne(filter, update, options = {}) {
          const found = docs(name).find((doc) => matches(doc, filter));
          if (found) {
            applyUpdate(found, update, false);
            return { matchedCount: 1, upsertedCount: 0 };
          }
          if (!options.upsert) return { matchedCount: 0, upsertedCount: 0 };
          const created = { ...(filter._id !== undefined && typeof filter._id !== "object" ? { _id: filter._id } : {}) };
          applyUpdate(created, update, true);
          docs(name).push(created);
          return { matchedCount: 0, upsertedCount: 1 };
        },
        aggregate(pipeline) {
          return { toArray: async () => runPipeline(docs(name), pipeline) };
        },
        async findOneAndUpdate(filter, update) {
          const found = docs(name).find((doc) => matches(doc, filter));
          if (!found) return null;
          applyUpdate(found, update, false);
          return { ...found };
        },
      };
    },
  };
}

// -- Fixtures --------------------------------------------------------------------

const instructors = [
  { _id: "i-ravi", name: "Ravi Teja", report_token: "tokRaviTokRaviTokRavi1" },
  { _id: "i-asha", name: "Asha P", report_token: "tokAshaTokAshaTokAsha1" },
  { _id: "i-kiran", name: "Kiran", report_token: null, college_id: "c2" },
  { _id: "i-meena", name: "Meena", report_token: "tokMeenaTokMeenaTokMe1" },
  { _id: "i-anil", name: "Anil", report_token: "tokAnilTokAnilTokAnil11" },
];

const session = (id, instructorId, name, checkIn, extra = {}) => ({
  _id: id,
  instructor_id: instructorId,
  instructor_name: name,
  college_id: "c1",
  attendance_day: "2026-09-30",
  date: checkIn,
  check_in_time: checkIn,
  check_out_time: null,
  status: "pending",
  ...extra,
});

const attendance = [
  session("a-ravi", "i-ravi", "Ravi Teja", ist(9, 11), {
    status: "non_compliant",
    check_out_time: ist(18, 5),
    checkout_compliance_status: "COMPLIANT",
    check_in_photo_key: "photos/ravi-in.jpg",
    check_out_photo_key: "photos/ravi-out.jpg",
  }),
  session("a-asha", "i-asha", "Asha P", ist(9, 5), { status: "compliant" }),
  // No college on the record: the instructor's is used.
  session("a-kiran", "i-kiran", "Kiran", ist(12, 59), { college_id: null }),
  session("a-late", "i-meena", "Meena", ist(13, 30)),
  session("a-both", "i-anil", "Anil", ist(14, 0), {
    status: "compliant",
    check_out_time: ist(15, 0),
    checkout_compliance_status: "NON_COMPLIANT",
  }),
  session("a-unknown", null, null, ist(10, 0), { status: "unidentified", check_in_photo_key: "photos/unknown.jpg" }),
  session("a-deleted", "i-asha", "Asha P", ist(10, 30), { deleting_at: ist(11, 0) }),
  session("a-yesterday", "i-ravi", "Ravi Teja", ist(10, 0, -1), { attendance_day: "2026-09-29", status: "compliant" }),
];

const evaluations = [
  {
    attendance_id: "a-ravi",
    kind: "checkin",
    overall_status: "NON_COMPLIANT",
    improvement_tips: ["Button the collar properly and tuck the shirt in.", "Wear your instructor ID card."],
  },
  { attendance_id: "a-ravi", kind: "checkout", overall_status: "COMPLIANT", improvement_tips: [] },
  { attendance_id: "a-asha", overall_status: "COMPLIANT", improvement_tips: [] },
  { attendance_id: "a-both", kind: "checkin", overall_status: "COMPLIANT" },
  {
    // Stored before tips were kept on the evaluation: derived from the rows.
    attendance_id: "a-both",
    kind: "checkout",
    overall_status: "NON_COMPLIANT",
    general_idcard_check: [{ code: "ID_PRESENT", status: "FAIL" }],
  },
];

const colleges = [
  { _id: "c1", name: "NIAT Hyderabad" },
  { _id: "c2", name: "Training Institute Bengaluru" },
];
const fixtureDb = () => memoryDb({ attendance, instructors, evaluations, colleges });
const morningRun = { _id: "daily-report:2026-09-30:13:00", date: "2026-09-30", slot: "13:00", window_from: ist(0), window_to: ist(13) };
const eveningRun = { _id: "daily-report:2026-09-30:18:30", date: "2026-09-30", slot: "18:30", window_from: ist(13), window_to: ist(18, 30) };

// -- Times ---------------------------------------------------------------------

test("send times read in 12-hour form", () => {
  assert.equal(slotLabel("13:00"), "1:00 PM");
  assert.equal(slotLabel("18:30"), "6:30 PM");
  assert.equal(slotLabel("00:05"), "12:05 AM");
  assert.equal(slotLabel("12:00"), "12:00 PM");
});

test("the link and subject carry the date as DD-MM-YYYY and DD/MM/YYYY", () => {
  assert.equal(parseDateSegment("30-09-2026"), "2026-09-30");
  assert.equal(parseDateSegment("31-02-2026"), null, "not a real date");
  assert.equal(dailyReportSubject("2026-09-30"), "Daily report_Attendance & Grooming_Check_30/09/2026");
  assert.equal(dailyReportDayPath("2026-09-30", "abc"), "/daily-report/30-09-2026/abc");
});

test("send times must be valid, distinct and few", () => {
  assert.deepEqual(normaliseTimes(["18:30", "13:00"]), { ok: true, times: ["13:00", "18:30"] });
  assert.equal(normaliseTimes(["25:00"]).ok, false);
  assert.equal(normaliseTimes(["1:00"]).ok, false);
  assert.match(normaliseTimes(["13:00", "13:00"]).detail, /1:00 PM is listed twice/);
  assert.equal(normaliseTimes(Array.from({ length: 9 }, (_, i) => `1${i}:00`)).ok, false);
  assert.equal(normaliseTimes("13:00").ok, false);
});

// -- Which reports are due, and what each covers ---------------------------------

const schedule = (extra = {}) => ({ enabled: true, times: ["13:00", "18:30"], schedule_changed_at: ist(9, 0, -1), ...extra });

test("each report covers the time since the previous one, the first from midnight", () => {
  assert.deepEqual(dueDailyReports(schedule(), ist(12, 59)), []);
  const evening = dueDailyReports(schedule(), ist(19, 0));
  assert.deepEqual(evening.map((due) => [due.slot, due.from.toISOString(), due.to.toISOString()]), [
    ["13:00", ist(0).toISOString(), ist(13).toISOString()],
    ["18:30", ist(13).toISOString(), ist(18, 30).toISOString()],
  ]);
  assert.equal(evening[0].dateKey, "2026-09-30");
});

test("a time already past when saved starts tomorrow, and the morning is not lost", () => {
  // Turned on at 2 PM: no 1 PM report today, and the 6:30 PM report covers the whole day.
  const due = dueDailyReports(schedule({ schedule_changed_at: ist(14, 0) }), ist(19, 0));
  assert.deepEqual(due.map((entry) => [entry.slot, entry.from.toISOString()]), [["18:30", ist(0).toISOString()]]);
  assert.deepEqual(dueDailyReports(schedule({ enabled: false }), ist(19, 0)), []);
  assert.deepEqual(dueDailyReports(schedule({ times: [] }), ist(19, 0)), []);
});

// -- The report ------------------------------------------------------------------

test("the morning report lists that period's check-ins, non-compliant first", async () => {
  const report = await buildDailyReport(fixtureDb(), morningRun);
  assert.equal(report.subject, "Daily report_Attendance & Grooming_Check_30/09/2026");
  assert.equal(report.windowLabel, "12:00 AM to 01:00 PM");
  // Kiran's check-in is still being analysed: only a finished verdict is reported.
  assert.deepEqual(report.rows.map((row) => row.name), ["Ravi Teja", "Asha P"]);
  const [ravi, asha] = report.rows;
  assert.equal(ravi.checkIn, "09:11 AM");
  assert.equal(ravi.institute, "NIAT Hyderabad");
  assert.equal(ravi.checkOut, "-", "the 6:05 PM check-out had not happened by 1 PM");
  assert.equal(ravi.status, "non_compliant");
  assert.deepEqual(ravi.points, ["Button the collar properly and tuck the shirt in. Wear your instructor ID card."]);
  assert.equal(ravi.reportUrl, "https://nxtgroom-xi.vercel.app/reports/tokRaviTokRaviTokRavi1/day/2026-09-30/check-in");
  assert.equal(asha.status, "compliant");
  assert.deepEqual(asha.points, ["No improvements needed"]);
});

test("a check-in still being analysed, not assessed, or failed to analyse is left out of the email", async () => {
  const db = memoryDb({
    attendance: [
      session("s-done", "i-asha", "Asha P", ist(9, 0), { status: "compliant" }),
      session("s-pending", "i-meena", "Meena", ist(9, 10)),
      session("s-unassessed", "i-anil", "Anil", ist(9, 20), { status: "unassessed" }),
      session("s-error", "i-ravi", "Ravi Teja", ist(9, 30), { status: "analysis_error" }),
    ],
    instructors,
    evaluations: [],
    colleges,
  });
  const report = await buildDailyReport(db, morningRun);
  assert.deepEqual(report.rows.map((row) => [row.name, row.status]), [["Asha P", "compliant"]]);
});

test("unidentified, deleted and other days' records are left out", async () => {
  const names = (await buildDailyReport(fixtureDb(), morningRun)).rows.map((row) => row.name);
  assert.ok(!names.includes("Instructor"));
  assert.equal(names.filter((name) => name === "Asha P").length, 1, "the deleted record is not counted");
  assert.equal(names.filter((name) => name === "Ravi Teja").length, 1, "yesterday's record is not counted");
});

test("the evening report covers the afternoon, check-outs included, judged on the check-in", async () => {
  const report = await buildDailyReport(fixtureDb(), eveningRun);
  const byName = Object.fromEntries(report.rows.map((row) => [row.name, row]));
  // Meena's check-in is still being analysed, so she is left out.
  assert.deepEqual(report.rows.map((row) => row.name), ["Ravi Teja", "Anil"]);
  assert.equal(byName["Ravi Teja"].checkIn, "09:11 AM");
  assert.equal(byName["Ravi Teja"].checkOut, "06:05 PM");
  // Listed for his check-out, but the status and feedback are his check-in's.
  assert.equal(byName["Ravi Teja"].status, "non_compliant");
  assert.deepEqual(byName["Ravi Teja"].points, ["Button the collar properly and tuck the shirt in. Wear your instructor ID card."]);
  assert.match(byName["Ravi Teja"].reportUrl, /\/check-in$/);
  // Anil's check-out failed, but only the check-in is reported.
  assert.equal(byName.Anil.status, "compliant");
  assert.deepEqual(byName.Anil.points, ["No improvements needed"]);
});

test("the email gives every instructor a report link, creating a missing one", async () => {
  // Kiran has no report link yet; his check-in is finished here so he is listed.
  const db = memoryDb({
    attendance: attendance.map((row) => (row._id === "a-kiran" ? { ...row, status: "compliant" } : row)),
    instructors,
    evaluations,
    colleges,
  });
  const report = await buildDailyReportForEmail(db, { ...morningRun, _id: "email-test-run" });
  const kiran = report.rows.find((row) => row.name === "Kiran");
  // No institute on Kiran's check-in: his own is named.
  assert.equal(kiran.institute, "Training Institute Bengaluru");
  assert.match(kiran.reportUrl, /^https:\/\/nxtgroom-xi\.vercel\.app\/reports\/[A-Za-z0-9_-]{20,}\/day\/2026-09-30\/check-in$/);
  assert.ok(db.docs("instructors").find((row) => row._id === "i-kiran").report_token, "the token is stored");
});

// -- The email -------------------------------------------------------------------

test("the email is the table, with a link to the whole report at the top", async () => {
  const report = await buildDailyReport(fixtureDb(), morningRun);
  const pageUrl = "https://nxtgroom-xi.vercel.app/daily-report/30-09-2026/1-00-pm/secretsecretsecret";
  const email = buildDailyReportEmail({ ...report, pageUrl });
  assert.equal(email.subject, "Daily report_Attendance & Grooming_Check_30/09/2026");
  assert.match(email.html, /<th>Instructor Name<\/th><th>Institute Name<\/th><th>Check-in Time<\/th><th>Check-out Time<\/th><th>Status<\/th><th>Feedback<\/th><th>Report<\/th>/);
  // The institute sits between the name and the check-in time.
  assert.ok(email.html.includes('<tr><td>Ravi Teja</td><td>NIAT Hyderabad</td><td class="t">09:11 AM</td>'));
  // The status sits between the check-out time and the feedback, red or green.
  assert.ok(email.html.includes('<td class="t">-</td><td class="t" style="color:#b91c1c;font-weight:700">Non-compliant</td><td>Button the collar properly'));
  assert.ok(email.html.includes('<td class="t" style="color:#15803d;font-weight:700">Compliant</td><td>No improvements needed</td>'));
  assert.ok(!email.html.includes("Analysis in progress"), "pending check-ins are not in the email");
  const top = email.html.indexOf("See all reports");
  assert.ok(top > 0 && top < email.html.indexOf("<table"), "the link sits above the table");
  assert.ok(email.html.includes(`<a href="${pageUrl}" style="color:#2563eb">See all reports</a>`));
  assert.ok(email.html.includes('<a href="https://nxtgroom-xi.vercel.app/reports/tokRaviTokRaviTokRavi1/day/2026-09-30/check-in" style="color:#2563eb">Report</a>'));
  assert.equal((email.html.match(/>Report<\/a>/g) || []).length, 2, "one per listed instructor");
  assert.ok(email.text.includes(`See all reports: ${pageUrl}`));
  assert.match(email.text, /Ravi Teja \| NIAT Hyderabad \| Check-in 09:11 AM \| Check-out - \| Non-compliant\n  Feedback: Button the collar/);
});

test("names are escaped, and an empty period still sends a clear email", () => {
  const email = buildDailyReportEmail({
    subject: "s", dateLabel: "30/09/2026", windowLabel: "12:00 AM to 01:00 PM", pageUrl: "https://x.test/p",
    rows: [{ name: "<b>Evil</b>", checkIn: "09:00 AM", checkOut: "-", points: ["a & b"], reportUrl: null }],
  });
  assert.ok(email.html.includes("&lt;b&gt;Evil&lt;/b&gt;"));
  assert.ok(email.html.includes("a &amp; b"));
  assert.ok(email.html.includes("<td>&lt;b&gt;Evil&lt;/b&gt;</td><td>-</td>"), "no institute reads as a dash");
  const empty = buildDailyReportEmail({ subject: "s", dateLabel: "30/09/2026", windowLabel: "12:00 AM to 01:00 PM", rows: [], pageUrl: "https://x.test/p" });
  assert.match(empty.html, /No check-ins or check-outs between 12:00 AM to 01:00 PM/);
  assert.match(empty.html, /0 instructors/);
});

// -- Settings ----------------------------------------------------------------------

test("the switch, the times and the recipients are saved, and the recipients are their own list", async () => {
  const db = memoryDb({ app_settings: [{ _id: "rp_recipients", emails: ["rp@nxtwave.co.in"] }] });
  assert.deepEqual(await getDailyReportSettings(db), { enabled: false, times: [], emails: [], schedule_changed_at: null });

  const saved = await saveDailyReportSchedule(db, { enabled: true, times: ["18:30", "13:00"] }, "admin@x");
  assert.deepEqual(saved, { ok: true, settings: { enabled: true, times: ["13:00", "18:30"], emails: [] } });
  const changedAt = (await getDailyReportSettings(db)).schedule_changed_at;
  assert.ok(changedAt instanceof Date);

  assert.equal((await saveDailyReportSchedule(db, { enabled: "yes" })).ok, false);
  assert.equal((await saveDailyReportSchedule(db, { times: ["13:00", "13:00"] })).ok, false);

  assert.deepEqual(await addDailyReportRecipient(db, " Head@NxtWave.co.in ", "admin@x"), { ok: true, emails: ["head@nxtwave.co.in"] });
  assert.equal((await addDailyReportRecipient(db, "head@nxtwave.co.in")).reason, "duplicate");
  assert.equal((await addDailyReportRecipient(db, "not-an-email")).reason, "invalid");
  assert.deepEqual(
    db.docs("app_settings").find((doc) => doc._id === "rp_recipients").emails,
    ["rp@nxtwave.co.in"],
    "the reporting partners are untouched"
  );

  // Adding a recipient is not a schedule change.
  assert.equal((await getDailyReportSettings(db)).schedule_changed_at.getTime(), changedAt.getTime());
  assert.deepEqual(await removeDailyReportRecipient(db, "head@nxtwave.co.in"), { ok: true, emails: [] });
});

// -- Sending exactly once ------------------------------------------------------------

function schedulerDb() {
  return memoryDb({
    ...{ attendance, instructors, evaluations },
    app_settings: [{
      _id: "daily_report",
      enabled: true,
      times: ["13:00", "18:30"],
      emails: ["head@nxtwave.co.in", "ops@nxtwave.co.in"],
      schedule_changed_at: ist(9, 0, -1),
    }],
  });
}

test("a due report is queued once per recipient, and never twice", async () => {
  const db = schedulerDb();
  assert.deepEqual(await runDueDailyReports(db, ist(12, 59)), []);

  assert.deepEqual(await runDueDailyReports(db, ist(13, 0, 0)), ["daily-report:2026-09-30:13:00"]);
  const run = db.docs("report_delivery_runs").find((doc) => doc.type === "daily_report");
  assert.equal(run.window_from.getTime(), ist(0).getTime());
  assert.equal(run.window_to.getTime(), ist(13).getTime());
  assert.equal(run.queued, 2);
  // The day's full page exists before the first email that links to it.
  const day = db.docs("report_delivery_runs").find((doc) => doc._id === "daily-report-day:2026-09-30");
  assert.equal(day.type, "daily_report_day");
  assert.match(day.link_token, UUID, "a random UUID");
  assert.equal(day.expires_at.getTime(), ist(24).getTime() + 30 * 24 * 60 * 60 * 1000, "30 days after the day ends");
  assert.ok(run.jobs_queued_at);
  const jobs = db.docs("mail_jobs");
  assert.deepEqual(jobs.map((job) => job.to_email).sort(), ["head@nxtwave.co.in", "ops@nxtwave.co.in"]);
  assert.ok(jobs.every((job) => job.type === "daily_report" && job.run_id === run._id && job.payload.run_id === run._id));

  // Another tick, or another server with its own memory: nothing new.
  assert.deepEqual(await runDueDailyReports(db, ist(13, 1)), []);
  assert.equal(db.docs("mail_jobs").length, 2);

  // The evening adds only the evening.
  assert.deepEqual(await runDueDailyReports(db, ist(18, 30)), ["daily-report:2026-09-30:18:30"]);
  assert.equal(db.docs("mail_jobs").length, 4);
  const evening = db.docs("report_delivery_runs").find((doc) => doc._id.endsWith("18:30"));
  assert.equal(evening.window_from.getTime(), ist(13).getTime());
  assert.equal(
    db.docs("report_delivery_runs").filter((doc) => doc.type === "daily_report_day").length,
    1,
    "both emails share the day's one page"
  );
});

test("a server that stopped half way finishes the run without duplicating emails", async () => {
  const db = schedulerDb();
  await runDueDailyReports(db, ist(13, 0));
  const run = db.docs("report_delivery_runs").find((doc) => doc.type === "daily_report");
  const day = () => db.docs("report_delivery_runs").find((doc) => doc.type === "daily_report_day");
  const token = day().link_token;
  delete run.jobs_queued_at; // As if it crashed before marking the run queued.
  assert.deepEqual(await runDueDailyReports(db, ist(13, 5)), ["daily-report:2026-09-30:13:00"]);
  assert.equal(db.docs("mail_jobs").length, 2, "the same two job ids");
  assert.equal(day().link_token, token, "the link does not change");
});

test("nothing is sent while switched off or with nobody to send to", async () => {
  const off = schedulerDb();
  off.docs("app_settings")[0].enabled = false;
  assert.deepEqual(await runDueDailyReports(off, ist(19, 0)), []);
  const nobody = schedulerDb();
  nobody.docs("app_settings")[0].emails = [];
  assert.deepEqual(await runDueDailyReports(nobody, ist(19, 0)), []);
  assert.equal(nobody.docs("mail_jobs").length, 0);
});

// -- The public link ---------------------------------------------------------------

test("one link per day opens that day only, and only for 30 days after it", async () => {
  const db = schedulerDb();
  const first = await ensureDailyReportDay(db, "2026-09-30", ist(13, 0));
  const again = await ensureDailyReportDay(db, "2026-09-30", ist(18, 30));
  assert.equal(again.link_token, first.link_token, "the 1 PM and 6:30 PM emails carry the same link");
  const token = first.link_token;
  const at = ist(20, 0);
  assert.ok(await findDailyReportDay(db, "30-09-2026", token, at));
  assert.equal(await findDailyReportDay(db, "30-09-2026", `${token.slice(0, -1)}x`, at), null, "wrong secret");
  assert.equal(await findDailyReportDay(db, "01-10-2026", token, at), null, "another day");
  assert.equal(await findDailyReportDay(db, "2026-09-30", token, at), null, "malformed date");
  assert.equal(await findDailyReportDay(db, "30-09-2026", "short", at), null);
  assert.ok(await findDailyReportDay(db, "30-09-2026", token, ist(23, 0, 30)), "still open on day 30");
  assert.equal(await findDailyReportDay(db, "30-09-2026", token, ist(0, 1, 31)), null, "expired after 30 days");

  // Opened again after it expired: a new link, and the old one stays closed.
  const renewed = await ensureDailyReportDay(db, "2026-09-30", ist(9, 0, 40));
  assert.notEqual(renewed.link_token, token);
  assert.match(renewed.link_token, UUID);
  assert.ok(await findDailyReportDay(db, "30-09-2026", renewed.link_token, ist(10, 0, 40)));
  assert.equal(await findDailyReportDay(db, "30-09-2026", token, ist(10, 0, 40)), null);

  // A past day opened later from the settings screen gets 30 days from then.
  const late = await ensureDailyReportDay(db, "2026-08-01", ist(10, 0));
  assert.equal(late.expires_at.getTime(), ist(10, 0).getTime() + 30 * 24 * 60 * 60 * 1000);
});

test("the full-day page lists the whole day, both halves, in check-in order", async () => {
  const db = fixtureDb();
  const report = await buildFullDayReport(db, "2026-09-30", { ensureTokens: true });
  assert.equal(report.windowLabel, "12:00 AM to 11:59 PM");
  assert.deepEqual(report.rows.map((row) => row.name), ["Asha P", "Ravi Teja", "Kiran", "Meena", "Anil"]);
  const byName = Object.fromEntries(report.rows.map((row) => [row.name, row]));

  const ravi = byName["Ravi Teja"];
  assert.equal(ravi.date, "30/09/2026");
  assert.equal(ravi.checkIn, "09:11 AM");
  assert.equal(ravi.checkOut, "06:05 PM", "the whole day, so the evening check-out is here");
  assert.equal(ravi.feedback, "Button the collar properly and tuck the shirt in. Wear your instructor ID card.", "the check-in's feedback only");
  assert.equal(ravi.institute, "NIAT Hyderabad");
  assert.equal(ravi.status, "non_compliant", "the check-in's result, which the page filters on");
  assert.equal(byName["Asha P"].status, "compliant");
  assert.equal(byName.Kiran.status, "pending");
  assert.equal(byName.Kiran.institute, "Training Institute Bengaluru", "from the instructor when the record has none");
  assert.equal(byName.Anil.status, "compliant", "the check-out's failure does not change the check-in's status");
  assert.equal(ravi.hasCheckinPhoto, true);
  assert.equal(ravi.hasCheckoutPhoto, true);
  assert.equal(ravi.checkinReportUrl, "https://nxtgroom-xi.vercel.app/reports/tokRaviTokRaviTokRavi1/day/2026-09-30/check-in");
  assert.equal(ravi.checkoutReportUrl, "https://nxtgroom-xi.vercel.app/reports/tokRaviTokRaviTokRavi1/day/2026-09-30/check-out");

  assert.equal(byName.Kiran.feedback, "Analysis in progress");
  assert.equal(byName.Kiran.checkOut, "-");
  assert.equal(byName.Kiran.checkoutReportUrl, null, "no check-out, no check-out report");
  assert.match(byName.Kiran.checkinReportUrl, /\/reports\/[A-Za-z0-9_-]{20,}\/day\/2026-09-30\/check-in$/, "a link is made for her");
  assert.equal(byName.Kiran.hasCheckinPhoto, false);
  assert.equal(byName.Anil.feedback, "No improvements needed", "his check-out failed, but the page shows the check-in");
  assert.ok(!report.rows.some((row) => row.name === "Instructor"), "no unidentified people");
  assert.equal(report.rows.filter((row) => row.name === "Ravi Teja").length, 1, "yesterday is not today");
});

test("the Reports tab counts each day and links its report", async () => {
  const db = memoryDb({
    attendance: [
      ...attendance,
      session("b-1", "i-asha", "Asha P", ist(9, 0, -2), { attendance_day: "2026-09-28", check_out_time: ist(17, 0, -2) }),
      session("b-2", "i-ravi", "Ravi Teja", ist(9, 30, -2), { attendance_day: "2026-09-28", check_out_time: ist(17, 30, -2), checkout_deleting_at: ist(18, 0, -2) }),
      session("b-3", "i-anil", "Anil", ist(23, 30, -3), { attendance_day: "2026-09-27" }),
    ],
    instructors,
    evaluations,
  });
  const days = await dailyReportDays(db, "2026-09", ist(20, 0));
  assert.equal(days.length, 30, "1 to 30 September, today included");
  assert.deepEqual(days.slice(0, 5).map((day) => day.date), ["2026-09-30", "2026-09-29", "2026-09-28", "2026-09-27", "2026-09-26"]);
  const byDate = Object.fromEntries(days.map((day) => [day.date, day]));

  // 30 Sep: five identified check-ins (the unidentified and deleted ones are
  // not counted), two of them checked out.
  assert.deepEqual(
    { ...byDate["2026-09-30"], report_url: undefined },
    { date: "2026-09-30", date_label: "30/09/2026", checkins: 5, checkouts: 2, not_checked_out: 3, report_url: undefined }
  );
  assert.match(byDate["2026-09-30"].report_url, /^https:\/\/nxtgroom-xi\.vercel\.app\/daily-report\/30-09-2026\/[0-9a-f-]{36}$/);
  // 28 Sep: a check-out being deleted does not count as a check-out.
  assert.equal(byDate["2026-09-28"].checkins, 2);
  assert.equal(byDate["2026-09-28"].checkouts, 1);
  assert.equal(byDate["2026-09-28"].not_checked_out, 1);
  // 11:30 PM on the 27th belongs to the 27th, in India time.
  assert.equal(byDate["2026-09-27"].checkins, 1);
  // A day nobody checked in has no report.
  assert.equal(byDate["2026-09-26"].checkins, 0);
  assert.equal(byDate["2026-09-26"].report_url, null);

  // Each day's link is that day's own, and the page lists what the row counts.
  const again = await dailyReportDays(db, "2026-09", ist(20, 5));
  assert.equal(again[0].report_url, days[0].report_url, "the same link on every refresh");
  assert.notEqual(byDate["2026-09-28"].report_url, byDate["2026-09-30"].report_url);
  assert.equal((await buildFullDayReport(db, "2026-09-30")).rows.length, byDate["2026-09-30"].checkins);

  assert.deepEqual(await dailyReportDays(db, "2026-10", ist(20, 0)), [], "a month that has not started");
  await assert.rejects(dailyReportDays(db, "2026-13", ist(20, 0)), /month must be YYYY-MM/);
  assert.equal(dayCountsPipeline(ist(0), ist(24))[1].$group._id.$dateToString.timezone, "Asia/Kolkata");
});

test("the page's photos are that day's listed sessions only", async () => {
  const db = fixtureDb();
  assert.equal(await dailyReportPhotoKey(db, "2026-09-30", "a-ravi", "checkin"), "photos/ravi-in.jpg");
  assert.equal(await dailyReportPhotoKey(db, "2026-09-30", "a-ravi", "checkout"), "photos/ravi-out.jpg");
  assert.equal(await dailyReportPhotoKey(db, "2026-09-30", "a-kiran", "checkin"), null, "none stored");
  assert.equal(await dailyReportPhotoKey(db, "2026-09-30", "a-unknown", "checkin"), null, "unidentified people are not shown");
  assert.equal(await dailyReportPhotoKey(db, "2026-10-01", "a-ravi", "checkin"), null, "another day's link");
  assert.equal(await dailyReportPhotoKey(db, "2026-09-30", "../etc", "checkin"), null);
});

// -- Wiring --------------------------------------------------------------------------

test("the settings, the public page, the mail worker and the scheduler are wired in", async () => {
  const admin = await readFile(new URL("../src/routes/adminRoutes.js", import.meta.url), "utf8");
  for (const route of [
    'adminRouter.get(\n  "/settings/daily-report",\n  requireSuperAdmin',
    'adminRouter.put(\n  "/settings/daily-report",\n  requireSuperAdmin',
    'adminRouter.post(\n  "/settings/daily-report/recipients",\n  requireSuperAdmin',
    'adminRouter.delete(\n  "/settings/daily-report/recipients/:email",\n  requireSuperAdmin',
  ]) {
    assert.ok(admin.replaceAll("\r\n", "\n").includes(route), `missing: ${route.split("\n")[1]}`);
  }
  assert.ok(admin.replaceAll("\r\n", "\n").includes('adminRouter.get(\n  "/settings/daily-report/days",\n  requireSuperAdmin'));
  const reports = (await readFile(new URL("../src/routes/reportRoutes.js", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  assert.ok(reports.includes('"/daily/:date/:token",\n  publicReportLimiter,'), "the public page is rate limited");
  assert.ok(reports.includes('"/daily/:date/:token/photo/:attendanceId/:kind",\n  publicReportLimiter,'), "so are its photos");
  const mail = await readFile(new URL("../src/services/mailWorker.js", import.meta.url), "utf8");
  assert.match(mail, /"daily_report",/);
  assert.match(mail, /if \(job\.type === "daily_report"\) return deliverDailyReport\(db, job\);/);
  assert.match(mail, /const result = await deliver\(db, job\);/);
  assert.match(mail, /pageUrl: dailyReportDayUrl\(day\)/, "See all reports opens the whole day");
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /startMailWorker\(db\),\s*startDailyReportScheduler\(db\),/);
});
