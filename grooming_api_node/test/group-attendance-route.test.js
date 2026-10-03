import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const SOURCE = new URL("../src/routes/attendanceRoutes.js", import.meta.url);

async function routeSource(path) {
  const source = await readFile(SOURCE, "utf8");
  const name = source.indexOf(`"${path}"`);
  assert.ok(name >= 0, `the ${path} route must exist`);
  const start = source.lastIndexOf("attendanceRouter.post(", name);
  const after = source.indexOf("attendanceRouter.post(", name + path.length);
  return source.slice(start, after > start ? after : undefined);
}

test("/auto/group is registered before any parameterised route", async () => {
  const source = await readFile(SOURCE, "utf8");
  const posts = [...source.matchAll(/attendanceRouter\.post\(\s*"([^"]+)"/g)].map((match) => match[1]);

  const group = posts.indexOf("/auto/group");
  const firstParameterised = posts.findIndex((path) => path.startsWith("/:"));
  assert.ok(group >= 0, "the group route must exist");
  assert.ok(
    group < firstParameterised,
    `/auto/group must precede the first parameterised POST route, got ${posts.join(", ")}`,
  );
});

test("the single-person route knows nothing about groups", async () => {
  const single = await routeSource("/auto");
  for (const symbol of [
    "identifyPeopleInPhoto",
    "GROUP_OUTCOMES",
    "groupTabletCaptureKey",
    "describeGroupOutcome",
    "groupCheckInLimiter",
    "groupMaxPeople",
  ]) {
    assert.ok(
      !single.includes(symbol),
      `${symbol} has leaked into the single-person route`,
    );
  }
  assert.ok(single.includes("searchFaceByImage("), "the single route still searches for one face");
});

test("each person is analysed on their own crop, never on the group photograph", async () => {
  const group = await routeSource("/auto/group");

  assert.ok(
    group.includes("body: person.image.buffer"),
    "the bytes uploaded for a person must be that person's crop",
  );
  assert.ok(
    !group.includes("body: groupImage.buffer"),
    "the group frame must never be uploaded as somebody's attendance photo",
  );
  assert.ok(
    group.includes("photoKey: evaluationPayload.photo_key"),
    "check-in analysis must run against the crop the record points at",
  );
});

test("the group photograph itself is never stored", async () => {
  const group = await routeSource("/auto/group");
  const uploads = [...group.matchAll(/uploadPhoto\(\{/g)];
  assert.equal(uploads.length, 1, "there should be exactly one upload helper, used per person");
  assert.ok(group.includes("capture_mode: \"group\""), "a crop should record how it was taken");
});

test("an outcome that records nothing stores no photograph", async () => {
  const group = await routeSource("/auto/group");
  const refusal = group.indexOf("KIOSK_ACTIONS.TOO_EARLY || action === KIOSK_ACTIONS.ALREADY_DONE");
  const store = group.indexOf("beginUpload(");
  assert.ok(refusal >= 0, "the route must handle the outcomes that record nothing");
  assert.ok(store > refusal, "nothing may be uploaded before those outcomes have returned");
});

test("one person's failure does not take everybody else's attendance with it", async () => {
  const group = await routeSource("/auto/group");
  assert.ok(group.includes("Promise.allSettled"), "one rejection must not reject the batch");
  assert.ok(
    group.includes("outcome.status === \"fulfilled\""),
    "a rejected turn must still be reported as that person's result",
  );
});

test("people are processed in bounded batches rather than all at once", async () => {
  const group = await routeSource("/auto/group");
  assert.ok(
    group.includes("config.groupCropConcurrency"),
    "the batch size must come from configuration, not be unbounded",
  );
});

test("the group route carries its own rate limit and concurrency gate", async () => {
  const source = await readFile(SOURCE, "utf8");
  const registration = source.slice(source.indexOf('"/auto/group"'));
  const handlerStart = registration.slice(0, registration.indexOf("asyncRoute("));

  assert.ok(handlerStart.includes("groupCheckInLimiter"), "a group request is several check-ins");
  assert.ok(handlerStart.includes("checkInConcurrencyGate"), "it decodes images like any other");
  const limit = /const groupCheckInLimiter = rateLimit\(\{[\s\S]*?limit: (\d+)/.exec(source);
  assert.ok(limit, "the group limiter must exist");
  assert.ok(Number(limit[1]) <= 100, "the group limiter must not be looser than the single one");
});

test("the check-out guard is the same one the single route uses", async () => {
  const group = await routeSource("/auto/group");
  assert.ok(
    group.includes("check_out_time: null"),
    "check-out must be guarded on the session still being open",
  );
  assert.ok(
    group.includes("attendanceScope(req.currentUser)"),
    "one campus must not be able to close another's session",
  );
});

test("a passer-by in the background is not recorded as an unidentified check-in", async () => {
  const group = await routeSource("/auto/group");
  const refusal = group.indexOf("GROUP_OUTCOMES.TOO_SMALL");
  const lookup = group.indexOf("activeInstructorFilter(req.currentUser, person.instructorId)");

  assert.ok(refusal >= 0, "a face too small to identify must be handled on its own");
  assert.ok(refusal < lookup, "it must be refused before anything is looked up or written");

  const branch = group.slice(refusal, group.indexOf("const instructor = person.instructorId"));
  assert.ok(branch.includes("recorded: false"), "nothing may be recorded for them");
  assert.ok(!branch.includes("beginUpload("), "nor may their photograph be stored");
});

test("the tablet hold suppresses unknown-only repeats and never blocks recognised group members", async () => {
  const group = await routeSource("/auto/group");
  const guard = /const hasUnrecognisedFaces = identified\.people\.some\(\(person\) => \(([\s\S]*?)\)\);/.exec(group);
  assert.ok(guard, "the hold must be decided from the outcomes");
  assert.ok(
    !guard[1].includes("TOO_SMALL"),
    "an outcome that records nothing must not make the tablet claim the hold",
  );
  assert.ok(guard[1].includes("NO_MATCH"), "an unrecognised person is what the hold is for");
});

test("every person's line carries a time, so the tablet can show one next to their name", async () => {
  const group = await routeSource("/auto/group");

  const defaults = /const answer = \(person, fields\) => \(\{[\s\S]*?recorded_at: null,\s*check_in_time: null,[\s\S]*?\.\.\.fields,/;
  assert.match(group, defaults, "a line with nothing known must say so with nulls, not omit the fields");

  const recorded = [...group.matchAll(/recorded_at: now,/g)];
  assert.equal(recorded.length, 2, "only recognised check-in and check-out record a time");

  assert.ok(group.includes("check_in_time: today?.check_in_time || null"), "too-early and already-done must carry the day's check-in");
  assert.ok(group.includes("check_in_time: today.check_in_time || null"), "a duplicate check-out must too");
  assert.ok(group.includes("check_in_time: attendance.check_in_time || null"));
});

test("somebody who already checked in is told when, even when the race was lost inside the transaction", async () => {
  const group = await routeSource("/auto/group");
  const fallback = group.indexOf('committed.outcome === "already_checked_in_today"');
  assert.ok(fallback >= 0, "the lost-race branch must look the day's record up");
  const lookup = group.indexOf("projection: { _id: 1, check_in_time: 1 }", fallback);
  assert.ok(lookup > fallback, "and read its time");
  assert.ok(group.includes("check_in_time: existing?.check_in_time || null"));
  assert.ok(group.slice(fallback, lookup).includes("try {"), "the lookup must be guarded");
});
