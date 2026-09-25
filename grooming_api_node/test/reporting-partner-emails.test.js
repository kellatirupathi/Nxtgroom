import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  addDaysToKey,
  ESCALATION_THRESHOLD,
  nonCompliantOccurrences,
  recoverClaimedEvaluation,
  weekStartKey,
} from "../src/services/evaluationWorker.js";
import { buildEscalationEmail, buildGroomingAlertEmail } from "../src/services/emailService.js";

/**
 * What reporting partners receive.
 *
 * Two additions, both alongside what was already sent and neither replacing it:
 *
 *  - a report for every COMPLIANT result, so partners hear about the
 *    instructors getting it right and not only the failures;
 *  - an URGENT escalation when one instructor fails three or more times in a
 *    Monday-to-Sunday week, sent again at each further failure that week, each
 *    listing the whole week.
 *
 * The end-to-end tests drive the worker's real completion path against a small
 * in-memory database, and read the mail queue it leaves behind: that queue is
 * exactly what would be emailed.
 */

function matches(doc, filter = {}) {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === "$or") {
      if (!condition.some((part) => matches(doc, part))) return false;
      continue;
    }
    const value = doc[key];
    const isOperator = condition && typeof condition === "object" && !Array.isArray(condition)
      && !(condition instanceof Date) && Object.keys(condition).some((k) => k.startsWith("$"));
    if (!isOperator) {
      if (String(value) !== String(condition)) return false;
      continue;
    }
    for (const [op, arg] of Object.entries(condition)) {
      if (op === "$in" && !arg.some((item) => String(item) === String(value))) return false;
      if (op === "$ne" && String(value) === String(arg)) return false;
      if (op === "$exists" && (value !== undefined) !== arg) return false;
      if (op === "$gte" && !(value >= arg)) return false;
      if (op === "$lte" && !(value <= arg)) return false;
    }
  }
  return true;
}

function memoryDb(seed = {}) {
  const collections = new Map(Object.entries(seed).map(([name, docs]) => [name, docs.map((d) => ({ ...d }))]));
  const docsOf = (name) => {
    if (!collections.has(name)) collections.set(name, []);
    return collections.get(name);
  };
  const db = {
    docs: docsOf,
    collection(name) {
      const docs = docsOf(name);
      return {
        async findOne(filter) {
          const found = docs.find((doc) => matches(doc, filter));
          return found ? { ...found } : null;
        },
        find(filter) {
          const result = docs.filter((doc) => matches(doc, filter)).map((doc) => ({ ...doc }));
          return { toArray: async () => result, project: () => ({ toArray: async () => result }) };
        },
        async updateOne(filter, update, options = {}) {
          // Lease bookkeeping is the worker's concern, not these tests'.
          if (name === "evaluation_jobs") return { matchedCount: 1, modifiedCount: 1 };
          const doc = docs.find((candidate) => matches(candidate, filter));
          if (!doc) {
            if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 };
            docs.push({ _id: filter._id, ...(update.$setOnInsert || {}), ...(update.$set || {}) });
            return { matchedCount: 0, upsertedCount: 1 };
          }
          Object.assign(doc, update.$set || {});
          for (const key of Object.keys(update.$unset || {})) delete doc[key];
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async deleteOne() { return { deletedCount: 1 }; },
        async deleteMany() { return { deletedCount: 0 }; },
        async findOneAndUpdate(filter) { return docs.find((doc) => matches(doc, filter)) || null; },
      };
    },
  };
  return db;
}

const RPS = ["rp.one@nxtwave.in", "rp.two@nxtwave.in"];
const INSTRUCTOR = { _id: "i1", name: "Himanshu", email: "himanshu@nxtwave.in", report_token: "tok-himanshu", gender: "MALE" };

function world({ attendance = [], rpSettings = {} } = {}) {
  return memoryDb({
    instructors: [INSTRUCTOR],
    app_settings: [{ _id: "rp_recipients", emails: RPS, checkin_enabled: true, checkout_enabled: true, ...rpSettings }],
    attendance,
  });
}

/** One attendance day for Himanshu. */
const day = (id, attendanceDay, extra = {}) => ({
  _id: id,
  instructor_id: "i1",
  attendance_day: attendanceDay,
  check_in_time: new Date(`${attendanceDay}T04:00:00Z`),
  status: "pending",
  ...extra,
});

/** Completes one evaluation through the worker's real path. */
async function complete(db, { attendanceId, kind = "checkin", overall = "NON_COMPLIANT", summary = "Sneakers instead of formal shoes." }) {
  const attendance = db.docs("attendance").find((doc) => doc._id === attendanceId);
  db.docs("evaluations").push({
    attendance_id: attendanceId,
    kind,
    overall_status: overall,
    ai_summary: summary,
    image_quality: "ADEQUATE",
    attire_type: "FORMAL",
  });
  const job = {
    _id: `${attendanceId}:${kind}`,
    attendance_id: attendanceId,
    kind,
    status: "processing",
    instructor: { id: "i1", name: INSTRUCTOR.name, email: INSTRUCTOR.email, gender: "MALE" },
    check_in_time: attendance.check_in_time,
    ...(kind === "checkout" ? { check_out_time: new Date(attendance.check_in_time.getTime() + 8 * 3600_000) } : {}),
  };
  assert.equal(await recoverClaimedEvaluation(db, job), true);
}

const mail = (db) => db.docs("mail_jobs");
const byPrefix = (db, fragment) => mail(db).filter((job) => job._id.includes(fragment));

test("a compliant check-in now reaches every reporting partner, and only them", async () => {
  const db = world({ attendance: [day("a1", "2026-09-25")] });
  await complete(db, { attendanceId: "a1", overall: "COMPLIANT", summary: "All standards met." });

  const reports = byPrefix(db, ":compliance-report:checkin:");
  assert.deepEqual(reports.map((job) => job.to_email).sort(), RPS);
  for (const job of reports) {
    assert.equal(job.type, "grooming_alert");
    assert.equal(job.payload.status, "compliant");
    assert.equal(job.payload.forReviewer, true);
    assert.match(job.payload.reportUrl, /\/reports\/tok-himanshu\/day\/2026-09-25\/check-in$/);
  }
  // The instructor already gets their own report for every result.
  assert.equal(reports.some((job) => job.to_email === INSTRUCTOR.email), false);
  // Nothing about a failure is sent for a pass.
  assert.equal(byPrefix(db, ":grooming-alert:").length, 0);
  assert.equal(byPrefix(db, "escalation:").length, 0);
});

test("a compliant check-out is reported to partners as a check-out", async () => {
  const db = world({ attendance: [day("a1", "2026-09-25", { status: "compliant" })] });
  await complete(db, { attendanceId: "a1", kind: "checkout", overall: "COMPLIANT" });
  const reports = byPrefix(db, ":compliance-report:checkout:");
  assert.equal(reports.length, 2);
  assert.match(reports[0].payload.reportUrl, /\/check-out$/);
  assert.equal(reports[0].payload.kind, "checkout");
});

test("a non-compliant result still sends exactly the alerts it always did", async () => {
  const db = world({ attendance: [day("a1", "2026-09-25")] });
  await complete(db, { attendanceId: "a1" });

  const alerts = byPrefix(db, ":grooming-alert:checkin:");
  assert.deepEqual(
    alerts.map((job) => `${job.payload.role}:${job.to_email}`).sort(),
    ["instructor:himanshu@nxtwave.in", ...RPS.map((rp) => `reporting_partner:${rp}`)].sort(),
  );
  assert.equal(byPrefix(db, ":compliance-report:").length, 0, "a failure is not also reported as a pass");
  assert.equal(byPrefix(db, "escalation:").length, 0, "one failure is not an escalation");
});

test("the third failure in a week escalates to every partner, listing the whole week", async () => {
  const db = world({
    attendance: [
      day("mon", "2026-09-21", { status: "non_compliant", remarks: "Shirt untucked." }),
      day("tue", "2026-09-22", {
        status: "compliant",
        checkout_compliance_status: "NON_COMPLIANT",
        checkout_remarks: "Hair falling across the forehead.",
        check_out_time: new Date("2026-09-22T12:30:00Z"),
      }),
      day("fri", "2026-09-25"),
    ],
  });
  await complete(db, { attendanceId: "fri", summary: "Sneakers instead of formal shoes." });

  const escalations = byPrefix(db, "escalation:i1:2026-09-21:3:");
  assert.deepEqual(escalations.map((job) => job.to_email).sort(), RPS);
  const [{ payload, type }] = escalations;
  assert.equal(type, "grooming_escalation");
  assert.equal(payload.count, 3);
  assert.equal(payload.weekStart, "2026-09-21");
  assert.equal(payload.weekEnd, "2026-09-27");
  assert.deepEqual(payload.occurrences.map((o) => `${o.day} ${o.kind}`), [
    "2026-09-21 checkin",
    "2026-09-22 checkout",
    "2026-09-25 checkin",
  ]);
  assert.deepEqual(payload.occurrences.map((o) => o.summary), [
    "Shirt untucked.",
    "Hair falling across the forehead.",
    "Sneakers instead of formal shoes.",
  ]);
  assert.match(payload.occurrences[1].reportUrl, /\/day\/2026-09-22\/check-out$/);
  // Sent in addition to the ordinary alert, never instead of it.
  assert.equal(byPrefix(db, "fri:grooming-alert:checkin:").length, 3);
});

test("the fourth failure sends a new escalation; a repeat of the third sends nothing", async () => {
  const db = world({
    attendance: [
      day("mon", "2026-09-21", { status: "non_compliant", remarks: "One." }),
      day("tue", "2026-09-22", { status: "non_compliant", remarks: "Two." }),
      day("wed", "2026-09-23"),
      day("thu", "2026-09-24"),
    ],
  });
  await complete(db, { attendanceId: "wed" });
  assert.equal(byPrefix(db, "escalation:i1:2026-09-21:3:").length, 2);

  // The same evaluation finishing twice - a retry - must not email twice.
  await complete(db, { attendanceId: "wed" });
  assert.equal(byPrefix(db, "escalation:").length, 2);

  await complete(db, { attendanceId: "thu" });
  const fourth = byPrefix(db, "escalation:i1:2026-09-21:4:");
  assert.equal(fourth.length, 2, "a fourth failure is news, and is sent");
  assert.equal(fourth[0].payload.count, 4);
  assert.equal(fourth[0].payload.occurrences.length, 4);
});

test("failures in last week do not count towards this week", async () => {
  const db = world({
    attendance: [
      day("lastFri", "2026-09-18", { status: "non_compliant", remarks: "Old." }),
      day("lastSat", "2026-09-19", { status: "non_compliant", remarks: "Old." }),
      day("mon", "2026-09-21"),
    ],
  });
  await complete(db, { attendanceId: "mon" });
  assert.equal(byPrefix(db, "escalation:").length, 0);
});

test("a partner switch turned off for a half silences that half's new emails too", async () => {
  const db = world({
    attendance: [day("a1", "2026-09-25")],
    rpSettings: { checkin_enabled: false },
  });
  await complete(db, { attendanceId: "a1", overall: "COMPLIANT" });
  assert.equal(byPrefix(db, ":compliance-report:").length, 0);
});

test("a photograph that could not be assessed sends partners nothing new", async () => {
  const db = world({ attendance: [day("a1", "2026-09-25")] });
  await complete(db, { attendanceId: "a1", overall: "UNASSESSED", summary: "No person visible." });
  assert.equal(byPrefix(db, ":compliance-report:").length, 0);
  assert.equal(byPrefix(db, "escalation:").length, 0);
});

test("the week runs Monday to Sunday", () => {
  assert.equal(weekStartKey("2026-09-21"), "2026-09-21", "Monday is its own week start");
  assert.equal(weekStartKey("2026-09-25"), "2026-09-21", "Friday");
  assert.equal(weekStartKey("2026-09-27"), "2026-09-21", "Sunday belongs to the week before it");
  assert.equal(weekStartKey("2026-09-28"), "2026-09-28", "the next Monday starts a new week");
  assert.equal(addDaysToKey("2026-09-28", 6), "2026-10-04", "across a month end");
  assert.equal(ESCALATION_THRESHOLD, 3);
});

test("check-in and check-out failures each count, and nothing else does", () => {
  const occurrences = nonCompliantOccurrences([
    { attendance_day: "2026-09-21", check_in_time: "2026-09-21T04:00:00Z", status: "non_compliant", remarks: "A" },
    { attendance_day: "2026-09-22", check_in_time: "2026-09-22T04:00:00Z", status: "fail", remarks: "B (legacy status)" },
    { attendance_day: "2026-09-23", check_in_time: "2026-09-23T04:00:00Z", status: "compliant", checkout_compliance_status: "NON_COMPLIANT", check_out_time: "2026-09-23T12:00:00Z", checkout_remarks: "C" },
    { attendance_day: "2026-09-24", check_in_time: "2026-09-24T04:00:00Z", status: "unassessed" },
    { attendance_day: "2026-09-25", check_in_time: "2026-09-25T04:00:00Z", status: "compliant", checkout_compliance_status: "NON_COMPLIANT", checkout_deleting_at: new Date(), checkout_remarks: "deleted" },
    { attendance_day: "2026-09-26", check_in_time: "2026-09-26T04:00:00Z", status: "non_compliant", deleting_at: new Date() },
  ]);
  assert.deepEqual(occurrences.map((o) => o.summary), ["A", "B (legacy status)", "C"]);
  assert.deepEqual(occurrences.map((o) => o.kind), ["checkin", "checkin", "checkout"]);
});

test("the non-compliant alert reads exactly as before", () => {
  const email = buildGroomingAlertEmail({
    name: "Himanshu",
    status: "non_compliant",
    summary: "Sneakers instead of formal shoes.",
    dateLabel: "2026-09-25",
    reportUrl: "https://app/reports/t/day/2026-09-25/check-in",
    forReviewer: true,
  });
  assert.equal(email.subject, "Check-in appearance alert: Himanshu - 2026-09-25");
  assert.match(email.text, /Himanshu's check-in on 2026-09-25 did not meet the appearance standards\./);
  assert.match(email.html, /#fff7ed/, "still the amber alert box");
});

test("the compliant report is marked Compliant in the subject and green in the body", () => {
  const email = buildGroomingAlertEmail({
    name: "Himanshu",
    status: "compliant",
    summary: "All appearance standards are met.",
    dateLabel: "2026-09-25",
    reportUrl: "https://app/reports/t/day/2026-09-25/check-out",
    forReviewer: true,
    kind: "checkout",
  });
  assert.equal(email.subject, "Check-out appearance report: Himanshu - 2026-09-25 (Compliant)");
  assert.match(email.text, /met the appearance standards/);
  assert.match(email.html, /#ecfdf5/);
  assert.doesNotMatch(email.html, /#fff7ed/);
});

test("the escalation says URGENT, how many times, and every occurrence", () => {
  const email = buildEscalationEmail({
    name: "Himanshu",
    count: 3,
    weekStart: "2026-09-21",
    weekEnd: "2026-09-27",
    occurrences: [
      { kind: "checkin", day: "2026-09-21", time: "2026-09-21T04:00:00Z", summary: "Shirt untucked.", reportUrl: "https://app/r/1" },
      { kind: "checkout", day: "2026-09-22", time: "2026-09-22T12:30:00Z", summary: "Hair <on> forehead.", reportUrl: "https://app/r/2" },
      { kind: "checkin", day: "2026-09-25", time: "2026-09-25T04:00:00Z", summary: "Sneakers.", reportUrl: "https://app/r/3" },
    ],
  });
  assert.match(email.subject, /^URGENT action needed: Check-in appearance report - Himanshu non-compliant 3 times this week \(21 Sept? 2026 to 27 Sept? 2026\)$/);
  assert.match(email.text, /not met the appearance standards 3 times this week/);
  for (const needle of ["Shirt untucked.", "Sneakers.", "https://app/r/1", "https://app/r/2", "https://app/r/3", "Check-out"]) {
    assert.ok(email.text.includes(needle), `text is missing ${needle}`);
    assert.ok(email.html.includes(needle), `html is missing ${needle}`);
  }
  // Times are shown in India time: 04:00 UTC is 09:30 IST.
  assert.match(email.text, /09:30/);
  assert.ok(email.html.includes("Hair &lt;on&gt; forehead."), "summaries are escaped");
});

test("both result paths hand every result to the partner notifications, after the existing alert", async () => {
  const source = await readFile(new URL("../src/services/evaluationWorker.js", import.meta.url), "utf8");
  const calls = [...source.matchAll(/await notifyReportingPartners\(db, \{/g)];
  assert.equal(calls.length, 2, "one for check-in, one for check-out");
  for (const call of calls) {
    const before = source.lastIndexOf("sendGroomingAlerts(db, {", call.index);
    assert.ok(before > 0 && call.index - before < 1500, "the existing alert must still come first");
  }
});
