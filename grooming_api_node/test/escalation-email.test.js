import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEscalationEmail } from "../src/services/emailService.js";

const base = {
  name: "Himanshu",
  count: 3,
  weekStart: "2026-09-21",
  weekEnd: "2026-09-27",
  occurrences: [
    { kind: "checkin", day: "2026-09-21", time: "2026-09-21T04:00:00Z", summary: "Shirt untucked.", reportUrl: "https://x/1" },
    { kind: "checkin", day: "2026-09-22", time: "2026-09-22T04:00:00Z", summary: "No belt.", reportUrl: "https://x/2" },
    { kind: "checkin", day: "2026-09-23", time: "2026-09-23T04:00:00Z", summary: "Sneakers.", reportUrl: "https://x/3" },
  ],
};

test("a streak escalation says days in a row, and lists every day with its report", () => {
  const email = buildEscalationEmail({ ...base, streak: true });
  assert.match(email.subject, /Himanshu non-compliant 3 days in a row/);
  assert.match(email.text, /at check-in on 3 days in a row this week/);
  for (const url of ["https://x/1", "https://x/2", "https://x/3"]) assert.ok(email.html.includes(url));
  assert.equal((email.html.match(/>Check-in</g) || []).length, 3);
});

test("an escalation queued before the change keeps its wording", () => {
  const email = buildEscalationEmail(base);
  assert.match(email.subject, /non-compliant 3 times this week/);
});
