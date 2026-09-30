import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import sharp from "sharp";
import { S3Client } from "@aws-sdk/client-s3";
import { attendanceRouter } from "../src/routes/attendanceRoutes.js";
import { setRekognitionClientForTests } from "../src/services/faceRecognition.js";
import { clearIdentificationSettingsCache } from "../src/services/identificationSettings.js";
import { normalizeAccessSettings, validateAccessSettings } from "../src/services/accessSettings.js";

const environment = {
  REKOGNITION_COLLECTION_ID: "unknown-capture-tests",
  AWS_REKOGNITION_REGION: "ap-south-1",
  REKOGNITION_ACCESS_KEY_ID: "test-only",
  REKOGNITION_SECRET_ACCESS_KEY: "test-only",
  REKOGNITION_MATCH_THRESHOLD: "95",
  R2_ENDPOINT: "https://storage.invalid",
  R2_BUCKET: "test-only-bucket",
  R2_ACCESS_KEY_ID: "test-only",
  R2_SECRET_ACCESS_KEY: "test-only",
  SETTINGS_STORE: "mongo",
};
const original = {};
let photo;
let storage;
before(async () => {
  for (const [key, value] of Object.entries(environment)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  photo = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "white" } }).jpeg().toBuffer();
  storage = mock.method(S3Client.prototype, "send", async () => {
    throw new Error("A rejected capture must never call storage");
  });
});
after(() => {
  setRekognitionClientForTests(null);
  clearIdentificationSettingsCache();
  mock.restoreAll();
  for (const key of Object.keys(environment)) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

const face = (left = 0.2) => ({
  BoundingBox: { Left: left, Top: 0.15, Width: 0.1, Height: 0.12 },
  Confidence: 99.9,
  Quality: { Sharpness: 80, Brightness: 70 },
});
const candidate = (id, score = 99) => ({ Similarity: score, Face: { FaceId: `face-${id}`, ExternalImageId: id } });
function recognition({ faces = [face()], matches = [], error = false } = {}) {
  let searches = 0;
  setRekognitionClientForTests({
    async send(command) {
      if (error) throw new Error("Simulated provider failure");
      if (command.constructor.name === "DetectFacesCommand") return { FaceDetails: faces };
      if (command.constructor.name === "SearchFacesByImageCommand") {
        return { FaceMatches: matches[searches++] || [] };
      }
      throw new Error("Unexpected recognition command");
    },
  });
}
function database({ instructor = null, attendance = null, mode = "FACE_ONLY" } = {}) {
  const writes = [];
  return {
    writes,
    collection(name) {
      return {
        async findOne() {
          if (name === "app_settings") return { default_mode: mode, college_modes: {} };
          if (name === "instructors") return instructor;
          if (name === "attendance") return attendance;
          throw new Error(`Unexpected database read: ${name}`);
        },
        async insertOne(doc) { writes.push({ name, doc }); return { insertedId: doc._id }; },
        async updateOne(query, update) { writes.push({ name, query, update }); return { matchedCount: 1 }; },
      };
    },
  };
}
let sequence = 0;
async function capture(path, db, body = {}, email = `tablet-${++sequence}@example.com`) {
  clearIdentificationSettingsCache();
  const layer = attendanceRouter.stack.find((entry) => entry.route?.path === path && entry.route.methods.post);
  assert.ok(layer, `Missing capture route ${path}`);
  const handler = layer.route.stack.at(-1).handle;
  let status = 200;
  let response;
  await handler({
    app: { locals: { db } },
    currentUser: { email, role: "BOA", collegeId: "college-1", referenceId: "boa-1" },
    file: { buffer: photo, mimetype: "image/jpeg" },
    body,
  }, {
    status(value) { status = value; return this; },
    json(value) { response = value; return this; },
  }, (error) => { throw error; });
  assert.ok(response, "Every request must receive a response");
  assert.deepEqual(db.writes, [], "Rejected captures must not write attendance, jobs or metadata");
  assert.equal(storage.mock.callCount(), 0, "Rejected captures must not upload photos to R2");
  return { status, response };
}

for (const scenario of [
  { name: "no match", options: {} },
  { name: "below threshold", options: { matches: [[candidate("i1", 90)]] } },
  { name: "no face", options: { faces: [] } },
  { name: "provider failure", options: { error: true } },
  { name: "match outside the tablet scope", options: { matches: [[candidate("other-campus")]] } },
]) {
  test(`single and photo-first check-in save nothing for ${scenario.name}`, async () => {
    for (const path of ["/auto", "/check-in"]) {
      recognition(scenario.options);
      const { status, response } = await capture(path, database(), { instructor_id: "untrusted-selection" });
      assert.equal(status, path === "/auto" ? 200 : 422);
      assert.equal(response.recorded, false);
      assert.equal(response.action, "NOT_RECOGNISED");
      assert.match(response.detail, /nothing was recorded/i);
      assert.equal(response.attendance_id ?? null, null);
    }
  });
}

test("an immediate unknown retake is not reported as already checked in or out", async () => {
  recognition();
  const email = "repeat-tablet@example.com";
  await capture("/auto", database(), {}, email);
  const { response } = await capture("/auto", database(), {}, email);
  assert.equal(response.duplicate, true);
  assert.equal(response.action, "NOT_RECOGNISED");
  assert.equal(response.recorded, false);
});

test("a group of unknown people saves no photographs or records", async () => {
  recognition({ faces: [face(0.15), face(0.6)] });
  const { response } = await capture("/auto/group", database());
  assert.equal(response.detected, 2);
  assert.equal(response.recorded, 0);
  assert.equal(response.people.length, 2);
  for (const person of response.people) {
    assert.equal(person.recorded, false);
    assert.equal(person.attendance_id, null);
    assert.equal(person.title, "Not recognised — not recorded");
  }
});

test("ambiguous group matches cannot create unnamed attendance", async () => {
  recognition({ faces: [face(0.15), face(0.6)], matches: [[candidate("i1")], [candidate("i1")]] });
  const { response } = await capture("/auto/group", database());
  assert.equal(response.recorded, 0);
  assert.ok(response.people.every((person) => person.action === "NOT_RECOGNISED" && !person.recorded));
});

test("an unknown group member does not prevent a recognised colleague's normal attendance response", async () => {
  const email = "mixed-group-after-unknown@example.com";
  recognition({ faces: [face(0.15), face(0.6)] });
  await capture("/auto/group", database(), {}, email);
  recognition({ faces: [face(0.15), face(0.6)], matches: [[candidate("i1")], []] });
  const { response } = await capture("/auto/group", database({
    instructor: { _id: "i1", name: "Asha", college_id: "college-1" },
    attendance: { _id: "existing-1", check_in_time: new Date(), check_out_time: new Date() },
  }), {}, email);
  assert.equal(response.people[0].action, "ALREADY_DONE");
  assert.equal(response.people[0].instructor_name, "Asha");
  assert.equal(response.people[1].action, "NOT_RECOGNISED");
  assert.equal(response.people[1].attendance_id, null);
});

test("selector mode keeps requiring a selected instructor", async () => {
  const { status, response } = await capture("/check-in", database({ mode: "SELECTOR" }));
  assert.equal(status, 422);
  assert.match(response.detail, /instructor_id is required/);
});

test("retired queue endpoints and identification permissions are unavailable", () => {
  const paths = attendanceRouter.stack.filter((entry) => entry.route).map((entry) => entry.route.path);
  assert.equal(paths.includes("/unidentified"), false);
  assert.equal(paths.includes("/:attendanceId/identify"), false);
  assert.equal(paths.includes("/:attendanceId/unidentified"), false);
  assert.equal("boa_can_identify" in normalizeAccessSettings({ boa_can_identify: true }), false);
  assert.equal(validateAccessSettings({ boa_can_identify: true }).valid, false);
});


test("selector check-in keeps the selected instructor and normal duplicate response", async () => {
  setRekognitionClientForTests({ async send() { throw new Error("Selector mode must not recognise a face"); } });
  const { status, response } = await capture("/check-in", database({
    mode: "SELECTOR",
    instructor: { _id: "i1", name: "Asha", email: "asha@example.com", college_id: "college-1" },
    attendance: { _id: "existing-1", check_in_time: new Date() },
  }), { instructor_id: "i1" });
  assert.equal(status, 409);
  assert.equal(response.attendance_id, "existing-1");
});
