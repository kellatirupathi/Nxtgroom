import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { DynamoDocumentDatabase } from "../src/docdb/database.js";
import { MemoryDynamoDriver } from "../src/docdb/driver.js";
import { allTableDefinitions, collectionSchema } from "../src/docdb/schema.js";
import { formAdminRouter, publicFormRouter } from "../src/routes/formRoutes.js";
import { describeRequest } from "../src/services/auditLog.js";
import { localDateKey } from "../src/services/instructorReports.js";
import {
  buildImportedResponse,
  buildPhotoPeople,
  readPeoplePlan,
  formPath,
  formSlug,
  importPhotoLinks,
  isFormToken,
  parseImportDate,
  parseImportTimestamp,
  readFormAnswers,
  readKeptPhotoIds,
  resolveFormDate,
} from "../src/services/instituteForms.js";
import { loggedPath } from "../server.js";

const PREFIX = "forms-";

function memoryDatabase() {
  const driver = new MemoryDynamoDriver(allTableDefinitions(PREFIX).map((table) => table.definition));
  return new DynamoDocumentDatabase({ driver, tablePrefix: PREFIX });
}

async function seededDatabase() {
  const db = memoryDatabase();
  const now = new Date();
  await db.collection("colleges").insertOne({ _id: "c1", name: "Aurora University", location: "Hyderabad", deleted_at: null, created_at: now });
  await db.collection("colleges").insertOne({ _id: "c2", name: "GMRIT", location: "Rajam", deleted_at: null, created_at: now });
  await db.collection("colleges").insertOne({ _id: "c3", name: "Closed College", location: "", deleted_at: now, created_at: now });
  return db;
}

async function serve(db, role = "ADMIN") {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.locals.db = db;
  app.use("/api/v2/forms", publicFormRouter);
  app.use("/api/v2", (req, _res, next) => {
    req.currentUser = role ? { email: "admin@example.com", role } : undefined;
    next();
  }, formAdminRouter);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v2`;
  const call = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, init);
    return { status: response.status, body: await response.json() };
  };
  return { call, close: () => server.close() };
}

function formBody(fields) {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  return body;
}

test("both new tables are declared with one response per institute per day", () => {
  assert.deepEqual(collectionSchema("form_responses").unique[0].fields, ["college_id", "form_date"]);
  assert.ok(collectionSchema("form_responses").indexes.some((index) => index.name === "by_date" && index.pk === null));
  assert.ok(collectionSchema("institute_form_links").indexes.some((index) => index.name === "by_token"));
  const names = allTableDefinitions("p-").map((table) => table.definition.TableName);
  assert.ok(names.includes("p-db-form_responses"));
  assert.ok(names.includes("p-db-institute_form_links"));
});

test("a link carries a readable name and an unguessable token", () => {
  assert.equal(formSlug("Ajeenkya DY Patil University"), "ajeenkya-dy-patil-university");
  assert.equal(formSlug("Chalapathy (CITY)"), "chalapathy-city");
  assert.equal(formSlug("   "), "institute");
  assert.equal(formPath("IIT kharagpur", "abcdefghijklmnopqrstuvwx"), "/form/iit-kharagpur/abcdefghijklmnopqrstuvwx");
  assert.ok(isFormToken("abcdefghijklmnopqrstuvwx"));
  assert.ok(!isFormToken("short"));
  assert.ok(!isFormToken("../../etc/passwd/xxxxxxxxxx"));
});

test("today, any earlier date and no future date can be opened", () => {
  assert.deepEqual(resolveFormDate(undefined, "2026-11-23"), { date: "2026-11-23" });
  assert.deepEqual(resolveFormDate("2026-11-22", "2026-11-23"), { date: "2026-11-22" });
  assert.match(resolveFormDate("2026-11-24", "2026-11-23").error, /not come yet/);
  assert.match(resolveFormDate("2026-02-30", "2026-11-23").error, /real calendar date/);
  assert.match(resolveFormDate("2019-12-31", "2026-11-23").error, /too far/);
});

test("the questions follow the Google Form: status, submitted by, and a reason only for No", () => {
  assert.deepEqual(Object.keys(readFormAnswers({}).errors).sort(), ["status", "submitted_by"]);
  assert.deepEqual(readFormAnswers({ status: "yes", submitted_by: "  Ravi   Kumar " }).errors, {});
  assert.equal(readFormAnswers({ status: "yes", submitted_by: "Ravi" }).submittedBy, "Ravi");
  assert.equal(readFormAnswers({ status: "no", submitted_by: "Ravi" }).errors.reason, "This is a required question");
  assert.equal(readFormAnswers({ status: "no", submitted_by: "Ravi", reason: "other" }).errors.reason, "Please type the other reason");
  const other = readFormAnswers({ status: "no", submitted_by: "Ravi", reason: "other", reason_other: "Exam duty" });
  assert.deepEqual([other.reason, other.reasonOther, other.errors], ["other", "Exam duty", {}]);
  assert.equal(readFormAnswers({ status: "yes", submitted_by: "Ravi", reason: "wfh" }).reason, null, "no reason is kept for Yes");
});

test("the kept photos list is a JSON list of ids", () => {
  assert.deepEqual(readKeptPhotoIds(undefined), []);
  assert.deepEqual(readKeptPhotoIds('["a1","b-2"]'), ["a1", "b-2"]);
  assert.deepEqual(readKeptPhotoIds('["ok", "../bad", 5]'), ["ok"]);
  assert.equal(readKeptPhotoIds("{not json"), null);
  assert.equal(readKeptPhotoIds('{"a":1}'), null);
});

test("sheet dates and timestamps are read day first, as Indian sheets write them", () => {
  assert.equal(parseImportDate("2026-11-23"), "2026-11-23");
  assert.equal(parseImportDate("23-11-2026"), "2026-11-23");
  assert.equal(parseImportDate("23/11/2026"), "2026-11-23");
  assert.equal(parseImportDate("3/4/2026"), "2026-04-03");
  assert.equal(parseImportDate("23 Nov 2026"), "2026-11-23");
  assert.equal(parseImportDate("5 September 2026"), "2026-09-05");
  assert.equal(parseImportDate("31/02/2026"), null);
  assert.equal(parseImportDate("tomorrow"), null);
  assert.equal(parseImportTimestamp("23/11/2026 10:04:31").toISOString(), "2026-11-23T04:34:31.000Z");
  assert.equal(parseImportTimestamp("23/11/2026 2:05 PM").toISOString(), "2026-11-23T08:35:00.000Z");
});

test("picture links keep only web addresses, at most five", () => {
  assert.deepEqual(importPhotoLinks("https://drive.google.com/open?id=1, https://drive.google.com/open?id=2 nonsense"), [
    "https://drive.google.com/open?id=1",
    "https://drive.google.com/open?id=2",
  ]);
  assert.equal(importPhotoLinks(Array.from({ length: 8 }, (_, i) => `https://x.example/${i}`).join(",")).length, 5);
});

test("an imported row is matched to its institute by name and marked manual", () => {
  const collegesByName = new Map([
    ["aurora university", [{ _id: "c1", name: "Aurora University" }]],
    ["twin", [{ _id: "t1", name: "Twin" }, { _id: "t2", name: "Twin" }]],
  ]);
  const options = { collegesByName, today: "2026-11-23", importedBy: "admin@example.com" };
  const built = buildImportedResponse({
    date: "22/11/2026", status: "No", university: "  aurora   university ", submitted_by: "Ravi", reason: "University Holiday",
  }, options);
  assert.equal(built.doc.college_id, "c1");
  assert.equal(built.doc.form_date, "2026-11-22");
  assert.equal(built.doc.status, "no");
  assert.equal(built.doc.reason, "university_holiday");
  assert.equal(built.doc.source, "manual");
  assert.equal(built.doc.imported_by, "admin@example.com");
  assert.equal(buildImportedResponse({ date: "22/11/2026", status: "Yes", university: "Twin", submitted_by: "R" }, options).error, 'More than one institute is named "Twin".');
  assert.match(buildImportedResponse({ date: "22/11/2026", status: "Yes", university: "Nowhere", submitted_by: "R" }, options).error, /No institute/);
  assert.match(buildImportedResponse({ date: "24/11/2026", status: "Yes", university: "Aurora University", submitted_by: "R" }, options).error, /not come yet/);
  assert.match(buildImportedResponse({ date: "22/11/2026", status: "Maybe", university: "Aurora University", submitted_by: "R" }, options).error, /Yes or No/);
  const other = buildImportedResponse({ date: "22/11/2026", status: "No", university: "Aurora University", submitted_by: "R", reason: "Exam duty" }, options);
  assert.deepEqual([other.doc.reason, other.doc.reason_other], ["other", "Exam duty"]);
});

test("each active institute gets one stable link; deleted ones get none", async () => {
  const db = await seededDatabase();
  const server = await serve(db);
  try {
    const first = await server.call("/form-links");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.map((row) => row.name), ["Aurora University", "GMRIT"]);
    assert.match(first.body[0].path, /^\/form\/aurora-university\/[A-Za-z0-9_-]{24}$/);
    const second = await server.call("/form-links");
    assert.deepEqual(second.body.map((row) => row.token), first.body.map((row) => row.token), "the same link every time");
    assert.notEqual(first.body[0].token, first.body[1].token);
  } finally {
    server.close();
  }
});

test("only administrators can read links and responses or import", async () => {
  const db = await seededDatabase();
  const server = await serve(db, "BOA");
  try {
    assert.equal((await server.call("/form-links")).status, 403);
    assert.equal((await server.call("/form-responses")).status, 403);
    const imported = await server.call("/form-responses/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows: [{ date: "2026-11-01" }] }),
    });
    assert.equal(imported.status, 403);
  } finally {
    server.close();
  }
});

test("the public form opens today, saves a No answer once, then edits the same response", async () => {
  const db = await seededDatabase();
  const server = await serve(db);
  try {
    const [link] = (await server.call("/form-links")).body;
    const today = localDateKey(new Date());

    const opened = await server.call(`/forms/${link.token}`);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.date, today);
    assert.equal(opened.body.institute.name, "Aurora University");
    assert.equal(opened.body.response, null);
    assert.deepEqual(opened.body.limits, { max_photos: 5, max_file_mb: 10 });

    const missing = await server.call(`/forms/${link.token}/${today}`, { method: "POST", body: formBody({ status: "no" }) });
    assert.equal(missing.status, 422);
    assert.deepEqual(Object.keys(missing.body.errors).sort(), ["reason", "submitted_by"]);

    const noPhoto = await server.call(`/forms/${link.token}/${today}`, { method: "POST", body: formBody({ status: "yes", submitted_by: "Ravi" }) });
    assert.equal(noPhoto.status, 422);
    assert.equal(noPhoto.body.errors.photos, "This is a required question", "Yes needs at least one photo");

    const saved = await server.call(`/forms/${link.token}/${today}`, {
      method: "POST",
      body: formBody({ status: "no", submitted_by: "Ravi Kumar", reason: "wfh" }),
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.response.status, "no");
    assert.equal(saved.body.response.reason_label, "WFH");
    assert.equal(saved.body.response.source, "automatic");

    const reopened = await server.call(`/forms/${link.token}?date=${today}`);
    assert.equal(reopened.body.response.submitted_by, "Ravi Kumar");

    const edited = await server.call(`/forms/${link.token}/${today}`, {
      method: "POST",
      body: formBody({ status: "no", submitted_by: "Ravi Kumar", reason: "other", reason_other: "Exam duty" }),
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.response.reason_label, "Other: Exam duty");
    assert.equal(edited.body.response.edit_count, 1);
    assert.equal((await db.collection("form_responses").find({}).toArray()).length, 1, "still one response for the day");

    const listed = await server.call(`/form-responses?from=${today}&to=${today}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].college_name, "Aurora University");
  } finally {
    server.close();
  }
});

test("future dates, bad dates and unknown links are refused", async () => {
  const db = await seededDatabase();
  const server = await serve(db);
  try {
    const [link] = (await server.call("/form-links")).body;
    const future = await server.call(`/forms/${link.token}?date=2999-01-01`);
    assert.equal(future.status, 422);
    assert.equal(future.body.institute.name, "Aurora University", "the page can still show the institute");
    const posted = await server.call(`/forms/${link.token}/2999-01-01`, {
      method: "POST",
      body: formBody({ status: "no", submitted_by: "R", reason: "wfh" }),
    });
    assert.equal(posted.status, 422);
    assert.equal((await server.call("/forms/abcdefghijklmnopqrstuvwx")).status, 404);
    assert.equal((await server.call("/forms/short")).status, 404);
  } finally {
    server.close();
  }
});

test("photos are refused when the answer is No, and non-images are refused", async () => {
  const db = await seededDatabase();
  const server = await serve(db);
  try {
    const [link] = (await server.call("/form-links")).body;
    const today = localDateKey(new Date());
    const withPhoto = formBody({ status: "no", submitted_by: "R", reason: "wfh" });
    withPhoto.append("photos", new Blob([Buffer.from("not really an image")], { type: "image/jpeg" }), "a.jpg");
    const refused = await server.call(`/forms/${link.token}/${today}`, { method: "POST", body: withPhoto });
    assert.equal(refused.status, 422);

    const fake = formBody({ status: "yes", submitted_by: "R" });
    fake.append("photos", new Blob([Buffer.from("not really an image at all")], { type: "image/jpeg" }), "a.jpg");
    const notImage = await server.call(`/forms/${link.token}/${today}`, { method: "POST", body: fake });
    assert.equal(notImage.status, 422);
    assert.match(notImage.body.detail, /does not match a supported image format/);

    const many = formBody({ status: "yes", submitted_by: "R" });
    for (let index = 0; index < 6; index += 1) {
      many.append("photos", new Blob([Buffer.from("x")], { type: "image/jpeg" }), `${index}.jpg`);
    }
    const tooMany = await server.call(`/forms/${link.token}/${today}`, { method: "POST", body: many });
    assert.equal(tooMany.status, 422);
    assert.match(tooMany.body.detail, /up to 5 photos/);
  } finally {
    server.close();
  }
});

test("import adds manual rows, skips bad ones and never overwrites an existing day", async () => {
  const db = await seededDatabase();
  const server = await serve(db);
  try {
    const rows = [
      { row: 2, date: "20/11/2026", status: "Yes", university: "Aurora University", submitted_by: "Ravi", picture: "https://drive.google.com/open?id=1" },
      { row: 3, date: "20/11/2026", status: "No", university: "Aurora University", submitted_by: "Ravi", reason: "WFH" },
      { row: 4, date: "20/11/2026", status: "No", university: "Unknown", submitted_by: "Ravi" },
      { row: 5, date: "20/11/2026", status: "No", university: "GMRIT", submitted_by: "Sita", reason: "University Holiday" },
    ];
    const result = await server.call("/form-responses/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.created, 2);
    assert.deepEqual(result.body.skipped.map((skip) => skip.row), [3, 4]);
    assert.match(result.body.skipped[0].reason, /already has a response/);

    const listed = await server.call("/form-responses?from=2026-11-20&to=2026-11-20");
    assert.equal(listed.body.length, 2);
    assert.ok(listed.body.every((row) => row.source === "manual"));
    assert.deepEqual(listed.body.find((row) => row.college_id === "c1").photo_links, ["https://drive.google.com/open?id=1"]);

    const tooMany = await server.call("/form-responses/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows: Array.from({ length: 1001 }, () => ({})) }),
    });
    assert.equal(tooMany.status, 422);
  } finally {
    server.close();
  }
});

test("the people the form sends are read strictly", () => {
  assert.deepEqual(readPeoplePlan(undefined), []);
  const plan = readPeoplePlan(JSON.stringify([
    { photo: "new:0", people: [{ crop: 0, instructor_id: "i1", source: "label", box: { left: 0.1, top: 0.2, width: 0.2, height: 0.6 } }, { crop: 1, instructor_id: null, source: "none" }] },
    { photo: "ph1", people: [{ id: "p1", instructor_id: "i2", source: "manual" }] },
  ]));
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0].people[0], { id: null, crop: 0, instructorId: "i1", labelName: null, labelId: null, source: "label", box: { left: 0.1, top: 0.2, width: 0.2, height: 0.6 } });
  const printed = readPeoplePlan(JSON.stringify([{ photo: "new:0", people: [{ crop: 0, instructor_id: null, source: "label", label_name: "  Sanjay  Rao ", label_id: "nw9999999" }] }]));
  assert.deepEqual([printed[0].people[0].labelName, printed[0].people[0].labelId], ["Sanjay Rao", "NW9999999"]);
  const junk = readPeoplePlan(JSON.stringify([{ photo: "new:0", people: [{ crop: 0, source: "label", label_id: "<script>" }] }]));
  assert.equal(junk[0].people[0].labelId, null);
  assert.equal(plan[0].people[1].source, "none");
  assert.equal(plan[1].people[0].id, "p1");
  assert.equal(readPeoplePlan("{not json"), null);
  assert.equal(readPeoplePlan(JSON.stringify([{ photo: "../x", people: [] }])), null);
  assert.equal(readPeoplePlan(JSON.stringify([{ photo: "new:0", people: [{ instructor_id: "i1" }] }])), null, "a person needs a cut-out or a saved id");
  assert.equal(readPeoplePlan(JSON.stringify([{ photo: "new:0", people: Array.from({ length: 61 }, (_, crop) => ({ crop })) }])), null);
});

test("saved people can be renamed or removed without new pictures; names come from the institute's list", async () => {
  const roster = new Map([
    ["i1", { id: "i1", name: "Ravi Kumar", employee_id: "NW1023" }],
    ["i2", { id: "i2", name: "Sita Devi", employee_id: "NW2044" }],
  ]);
  const existing = [
    { id: "p1", crop_key: "forms/c1/2026-11-23/ph1-p1.jpg", instructor_id: "i1", name: "Ravi Kumar", employee_id: "NW1023", source: "label" },
    { id: "p2", crop_key: "forms/c1/2026-11-23/ph1-p2.jpg", instructor_id: null, name: null, employee_id: null, source: "none" },
  ];
  const built = await buildPhotoPeople({
    entry: { photo: "ph1", people: [{ id: "p2", crop: null, instructorId: "i2", source: "manual", box: null }] },
    existing,
    crops: [],
    roster,
    collegeId: "c1",
    date: "2026-11-23",
    photoId: "ph1",
  });
  assert.deepEqual(built.people.map((person) => [person.id, person.name, person.employee_id, person.source, person.crop_key]), [
    ["p2", "Sita Devi", "NW2044", "manual", "forms/c1/2026-11-23/ph1-p2.jpg"],
  ]);
  assert.deepEqual(built.removed.map((person) => person.id), ["p1"], "the person left out is removed");
  assert.equal(built.stored.length, 0);

  const outsider = await buildPhotoPeople({
    entry: { photo: "ph1", people: [{ id: "p1", crop: null, instructorId: "someone-else", source: "manual", box: null }] },
    existing,
    crops: [],
    roster,
    collegeId: "c1",
    date: "2026-11-23",
    photoId: "ph1",
  });
  assert.deepEqual([outsider.people[0].instructor_id, outsider.people[0].name, outsider.people[0].source], [null, null, "none"], "only the institute's own instructors can be chosen");

  const printed = await buildPhotoPeople({
    entry: { photo: "ph1", people: [{ id: "p2", crop: null, instructorId: null, labelName: "Sanjay Rao", labelId: "NW9999999", source: "label", box: null }] },
    existing,
    crops: [],
    roster,
    collegeId: "c1",
    date: "2026-11-23",
    photoId: "ph1",
  });
  assert.deepEqual(
    [printed.people[0].instructor_id, printed.people[0].name, printed.people[0].employee_id, printed.people[0].source],
    [null, "Sanjay Rao", "NW9999999", "label"],
    "someone not in the list keeps the name and id printed on their label",
  );
});

test("the form lists only its own institute's current instructors", async () => {
  const db = await seededDatabase();
  await db.collection("instructors").insertOne({ _id: "i1", name: "Ravi Kumar", employee_id: "NW1023", college_id: "c1", deleted_at: null });
  await db.collection("instructors").insertOne({ _id: "i2", name: "Asha Rao", employee_id: "NW1024", college_id: "c1" });
  await db.collection("instructors").insertOne({ _id: "i3", name: "Gone Person", employee_id: "NW1025", college_id: "c1", deleted_at: new Date() });
  await db.collection("instructors").insertOne({ _id: "i4", name: "Other Campus", employee_id: "NW2000", college_id: "c2" });
  const server = await serve(db);
  try {
    const [link] = (await server.call("/form-links")).body;
    const listed = await server.call(`/forms/${link.token}/instructors`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, [
      { id: "i2", name: "Asha Rao", employee_id: "NW1024" },
      { id: "i1", name: "Ravi Kumar", employee_id: "NW1023" },
    ]);
    assert.equal((await server.call("/forms/abcdefghijklmnopqrstuvwx/instructors")).status, 404);

    const today = localDateKey(new Date());
    const bad = await server.call(`/forms/${link.token}/${today}`, {
      method: "POST",
      body: formBody({ status: "no", submitted_by: "R", reason: "wfh", people: "{broken" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test("form tokens are hidden in request logs and imports are audited", () => {
  assert.equal(loggedPath("/api/v2/forms/abcdefghijklmnopqrstuvwx/2026-11-23"), "/api/v2/forms/<token>/2026-11-23");
  assert.deepEqual(describeRequest("POST", "/api/v2/form-responses/import"), { action: "Created form responses import", category: "edit" });
});
