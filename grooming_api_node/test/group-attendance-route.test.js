import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

/**
 * The attendance endpoint that photographs several people at once.
 *
 * It is a second route rather than a change to the first, and the most
 * important property here is exactly that: the single-person flow is what
 * attendance normally runs on, and it must not have acquired a group's
 * concerns. That is asserted mechanically below rather than left to review.
 *
 * The rest are the failures this shape can have quietly. A photograph stored
 * for a record that was never written. A group frame uploaded under no record,
 * which the orphan reconciler would delete an hour later with nothing logged.
 * Six people analysed against one image and receiving six identical reports.
 * And one person's bad luck taking the other five people's attendance with it.
 */

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
  // Express matches in registration order, so a literal path declared after
  // "/:attendanceId/..." is read as an attendance id and never runs.
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
  // The whole point of adding a route rather than a mode. If a group concern
  // ever leaks into this handler, the flow every college currently depends on
  // has been changed by a feature none of them asked for yet.
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
  // And it still does its own thing: one search, one instructor.
  assert.ok(single.includes("searchFaceByImage("), "the single route still searches for one face");
});

test("each person is analysed on their own crop, never on the group photograph", async () => {
  // Six people sharing one image would receive six identical grooming reports
  // describing whoever the model happened to look at, which is worse than no
  // report at all because it reads as a real assessment.
  const group = await routeSource("/auto/group");

  assert.ok(
    group.includes("body: person.image.buffer"),
    "the bytes uploaded for a person must be that person's crop",
  );
  assert.ok(
    !group.includes("body: groupImage.buffer"),
    "the group frame must never be uploaded as somebody's attendance photo",
  );
  // The queued job carries the key that was just written for this person.
  assert.ok(
    group.includes("photoKey: evaluationPayload.photo_key"),
    "check-in analysis must run against the crop the record points at",
  );
});

test("the group photograph itself is never stored", async () => {
  // R2's orphan reconciler lists attendance/ and removes any key no record
  // points at. A group frame stored beside the crops would be reaped an hour
  // later, so it is not stored at all rather than stored and silently lost.
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
  // Five people should not lose their check-in because a sixth stood too far
  // back, so the turns are settled rather than awaited together.
  const group = await routeSource("/auto/group");
  assert.ok(group.includes("Promise.allSettled"), "one rejection must not reject the batch");
  assert.ok(
    group.includes("outcome.status === \"fulfilled\""),
    "a rejected turn must still be reported as that person's result",
  );
});

test("people are processed in bounded batches rather than all at once", async () => {
  // Each turn holds a crop, an upload and a MongoDB transaction, on a container
  // with 512MB and a fifth of a CPU.
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
  // Tighter than the single-person limiter, because each request costs more.
  const limit = /const groupCheckInLimiter = rateLimit\(\{[\s\S]*?limit: (\d+)/.exec(source);
  assert.ok(limit, "the group limiter must exist");
  assert.ok(Number(limit[1]) <= 100, "the group limiter must not be looser than the single one");
});

test("the check-out guard is the same one the single route uses", async () => {
  // Two photographs a moment apart must not both close one session.
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
  // The single-person screen refuses to fire when it sees more than one person,
  // so a colleague crossing the corridor behind the subject never reaches the
  // server. A group photograph is the whole frame, so they do — and recording
  // them would fill the unidentified queue with people who were not checking
  // in. Someone who genuinely stood too far back is told to stand closer and
  // photographed again a second later.
  const group = await routeSource("/auto/group");
  const refusal = group.indexOf("GROUP_OUTCOMES.TOO_SMALL");
  const lookup = group.indexOf("activeInstructorFilter(req.currentUser, person.instructorId)");

  assert.ok(refusal >= 0, "a face too small to identify must be handled on its own");
  assert.ok(refusal < lookup, "it must be refused before anything is looked up or written");

  const branch = group.slice(refusal, group.indexOf("const instructor = person.instructorId"));
  assert.ok(branch.includes("recorded: false"), "nothing may be recorded for them");
  assert.ok(!branch.includes("beginUpload("), "nor may their photograph be stored");
});

test("the tablet hold is taken only when a record for a stranger is at stake", async () => {
  // A frame where everybody matched cannot create duplicates — each of them is
  // answered from their own day's record — so it must not be blocked by the
  // hold, only start it.
  const group = await routeSource("/auto/group");
  const guard = /const willRecordStrangers = identified\.people\.some\(\(person\) => \(([\s\S]*?)\)\);/.exec(group);
  assert.ok(guard, "the hold must be decided from the outcomes");
  assert.ok(
    !guard[1].includes("TOO_SMALL"),
    "an outcome that records nothing must not make the tablet claim the hold",
  );
  assert.ok(guard[1].includes("NO_MATCH"), "an unrecognised person is what the hold is for");
});
