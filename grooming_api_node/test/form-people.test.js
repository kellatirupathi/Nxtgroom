import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import sharp from "sharp";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDocumentDatabase } from "../src/docdb/database.js";
import { MemoryDynamoDriver } from "../src/docdb/driver.js";
import { allTableDefinitions } from "../src/docdb/schema.js";
import { setRekognitionClientForTests } from "../src/services/faceRecognition.js";
import {
  assignLabels,
  bodyCropFromFace,
  dropBodyPartFaces,
  dropTinyFaces,
  instructorById,
  instructorByName,
  looksLikeId,
  normalizeIdText,
  planPhotoPeople,
  readLabels,
  sortLeftToRight,
  WHOLE_PHOTO,
} from "../src/services/formPeopleReading.js";
import { photoNeedsReading, PEOPLE_MAX_ATTEMPTS, readNextFormPhoto } from "../src/services/formPeopleWorker.js";
import { pendingPeopleFields, peopleStatusView, serializeFormResponse } from "../src/services/instituteForms.js";
import { localDateKey } from "../src/services/instructorReports.js";

// ---- reading the labels and cutting people out (no services) ------------

// The institute's instructors, with near-misses to make sure only the right
// one is picked.
const ROSTER = [
  { id: "a", name: "Dharani Kumari", employee_id: "NW2000317" },
  { id: "b", name: "Vyshnavi Reddy", employee_id: "NW2000316" },
  { id: "c", name: "Keerthi", employee_id: "NW2000613" },
  { id: "d", name: "Naresh Babu", employee_id: "NW0007351" },
  { id: "e", name: "Yasvanth Kumar", employee_id: "NW0007357" },
  { id: "x", name: "Dharani Priya", employee_id: "NW2000999" },
  { id: "y", name: "Ravi Teja", employee_id: "NW0007358" },
];

// The words as read from a sample photo (720 x 1280): each label is a name
// over an id, above its person.
const word = (text, left, top, width, height = 0.014, confidence = 85) => ({ text, confidence, box: { left, top, width, height } });
const SAMPLE_WORDS = [
  word("Dharani", 0.035, 0.415, 0.11), word("NW2000317", 0.035, 0.435, 0.13, 0.011),
  word("Vyshnavi", 0.215, 0.405, 0.125), word("NW2000316", 0.215, 0.427, 0.13, 0.011),
  word("Keerthi", 0.41, 0.41, 0.1), word("NW2000613", 0.405, 0.435, 0.13, 0.011),
  word("Naresh", 0.615, 0.403, 0.09), word("NW0007351", 0.615, 0.423, 0.13, 0.011),
  word("Yasvanth", 0.83, 0.395, 0.13), word("NW0007357", 0.83, 0.415, 0.13, 0.011),
];
const ASPECT = 720 / 1280;
const PEOPLE = [0.115, 0.27, 0.445, 0.675, 0.9].map((centerX) => ({ centerX, width: 0.21 }));

test("ids read with look-alike letters are put right, and only ids count as ids", () => {
  assert.equal(normalizeIdText("NW2OOO3I7"), "NW2000317");
  assert.equal(normalizeIdText("nw0007357"), "NW0007357");
  assert.ok(looksLikeId("NW2000317"));
  assert.ok(!looksLikeId("Dharani"));
  assert.ok(!looksLikeId("2026"));
});

test("an instructor is found by id (exact, or one character off when unique) or by a unique name", () => {
  assert.equal(instructorById("NW2000317", ROSTER).id, "a");
  assert.equal(instructorById("NW2O00317", ROSTER).id, "a");
  assert.equal(instructorById("NW000735", ROSTER), null, "a missing digit fits two people: not guessed");
  assert.equal(instructorById("NW9999999", ROSTER), null);
  assert.equal(instructorByName("Vyshnavi", ROSTER).id, "b");
  assert.equal(instructorByName("Dharani", ROSTER), null, "two Dharanis: not guessed");
});

test("every person gets the name and id printed above them; a misread id is saved by the name", () => {
  const labels = readLabels(SAMPLE_WORDS, ROSTER, ASPECT);
  assert.deepEqual(labels.map((label) => label.instructor?.employee_id), ["NW2000317", "NW2000316", "NW2000613", "NW0007351", "NW0007357"]);
  assert.deepEqual(assignLabels(PEOPLE, labels).map((label) => label?.instructor?.name), ["Dharani Kumari", "Vyshnavi Reddy", "Keerthi", "Naresh Babu", "Yasvanth Kumar"]);
  const misread = SAMPLE_WORDS.map((item) => (item.text === "NW2000316" ? { ...item, text: "Nama" } : item));
  assert.equal(assignLabels(PEOPLE, readLabels(misread, ROSTER, ASPECT))[1]?.instructor?.name, "Vyshnavi Reddy");
});

test("a missed person leaves only their own label unused; an extra one is left without a name", () => {
  const withoutSecond = PEOPLE.filter((_, index) => index !== 1);
  assert.deepEqual(assignLabels(withoutSecond, readLabels(SAMPLE_WORDS, ROSTER, ASPECT)).map((label) => label?.instructor?.name ?? null), ["Dharani Kumari", "Keerthi", "Naresh Babu", "Yasvanth Kumar"]);
  const extra = [...PEOPLE, { centerX: 0.56, width: 0.08 }].sort((a, b) => a.centerX - b.centerX);
  const names = assignLabels(extra, readLabels(SAMPLE_WORDS, ROSTER, ASPECT)).map((label) => label?.instructor?.name ?? null);
  assert.equal(names[extra.findIndex((spot) => spot.centerX === 0.56)], null);
});

test("a label not in the instructor list still names its person as printed; a stray word names no one", () => {
  const unknown = readLabels([word("Sanjay", 0.1, 0.4, 0.1), word("NW9999999", 0.1, 0.42, 0.13, 0.011)], ROSTER, ASPECT);
  const [given] = assignLabels([{ centerX: 0.16, width: 0.2 }], unknown);
  assert.deepEqual([given?.nameText, given?.idText, given?.instructor], ["Sanjay", "NW9999999", null]);
  const stray = assignLabels([{ centerX: 0.2, width: 0.2, faceTop: 0.05, faceHeight: 0.03 }], readLabels([word("Welcome", 0.1, 0.1, 0.2)], ROSTER, ASPECT));
  assert.equal(stray[0], null);
  const sameRow = readLabels([word("Keerthi", 0.1, 0.4, 0.1), word("NW2000613", 0.215, 0.4, 0.13)], ROSTER, ASPECT);
  assert.equal(sameRow[0].instructor?.id, "c");
});

// A group photo (1280 x 960) with only first names printed above the heads,
// none in the instructor list, and the phone's watermark at the bottom.
const W = 1280;
const H = 960;
const px = (left, top, width, height) => ({ left: left / W, top: top / H, width: width / W, height: height / H });
const GROUP_FACES = [px(165, 365, 60, 70), px(345, 325, 58, 68), px(522, 320, 58, 68), px(735, 275, 56, 70), px(1015, 210, 64, 78)];
const pxWord = (text, left, top, width, height = 40, confidence = 90) => ({ text, confidence, box: px(left, top, width, height) });
const GROUP_WORDS = [
  pxWord("Bhumika", 40, 192, 195), pxWord("Meghana", 278, 252, 182), pxWord("Sanjana", 478, 266, 158),
  pxWord("Yugandhar", 650, 195, 185), pxWord("Shreyansh", 978, 136, 200), pxWord("Galaxy", 62, 866, 90, 28),
];

test("names above heads name each person, the watermark no one; shoes and specks are not people", () => {
  const shoe = px(700, 830, 52, 50);
  const speck = px(300, 700, 20, 22);
  const people = planPhotoPeople({ faces: [...GROUP_FACES, shoe, speck], words: GROUP_WORDS, roster: ROSTER, aspect: W / H });
  assert.deepEqual(people.map((person) => person.name), ["Bhumika", "Meghana", "Sanjana", "Yugandhar", "Shreyansh"]);
  assert.ok(people.every((person) => person.instructor_id === null && person.source === "label"));
  const sittingInFront = px(740, 420, 60, 72);
  assert.ok(dropBodyPartFaces([...GROUP_FACES, sittingInFront]).includes(sittingInFront));
  assert.equal(dropTinyFaces([GROUP_FACES[0], speck]).length, 2, "too few faces to tell what size is usual");
  assert.deepEqual(sortLeftToRight([{ left: 0.5, width: 0.1 }, { left: 0.1, width: 0.1 }]).map((face) => face.left), [0.1, 0.5]);
});

test("each person is cut out from above the hair to below the feet, inside the photo", () => {
  const face = { left: 0.45, top: 0.1, width: 0.04, height: 0.039 };
  const head = face.height / 0.78;
  const crown = face.top - (head - face.height);
  const crop = bodyCropFromFace(face);
  assert.ok(crop.top + crop.height >= crown + head * 8.5, "a whole head of room below the shoes");
  assert.ok(crop.top < crown, "room above the hair");
  assert.equal(bodyCropFromFace(GROUP_FACES[0]).top + bodyCropFromFace(GROUP_FACES[0]).height, 1, "feet near the bottom: runs to the bottom");
  const edge = bodyCropFromFace({ left: 0.97, top: 0.9, width: 0.05, height: 0.05 });
  assert.ok(edge.left + edge.width <= 1 && edge.top + edge.height <= 1);
});

test("a photo with no face found is one person, the whole photo, named from a label anywhere in it", () => {
  const roster = [{ id: "i1", name: "Sushant Bakshi", employee_id: "NW0001234" }];
  const [person] = planPhotoPeople({ faces: [], words: [word("Sushant", 0.1, 0.02, 0.2), word("NW0001234", 0.1, 0.04, 0.25, 0.011)], roster, aspect: 0.5 });
  assert.deepEqual(person.box, WHOLE_PHOTO);
  assert.deepEqual([person.instructor_id, person.name, person.employee_id, person.source], ["i1", "Sushant Bakshi", "NW0001234", "label"]);
  const [unnamed] = planPhotoPeople({ faces: [], words: [word("Camera", 0.7, 0.95, 0.2)], roster, aspect: 0.5 });
  assert.deepEqual([unnamed.name, unnamed.source], [null, "none"], "a stray word does not name them");
});

// ---- the background worker (Rekognition and storage stubbed) --------------

const environment = {
  REKOGNITION_COLLECTION_ID: "form-people-tests",
  AWS_REKOGNITION_REGION: "ap-south-1",
  REKOGNITION_ACCESS_KEY_ID: "test-only",
  REKOGNITION_SECRET_ACCESS_KEY: "test-only",
  R2_ENDPOINT: "https://storage.invalid",
  R2_BUCKET: "test-only-bucket",
  R2_ACCESS_KEY_ID: "test-only",
  R2_SECRET_ACCESS_KEY: "test-only",
};
const original = {};
const stored = new Map();
let photoBytes;

before(async () => {
  for (const [key, value] of Object.entries(environment)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  photoBytes = await sharp({ create: { width: 1280, height: 960, channels: 3, background: "#8090a0" } }).jpeg().toBuffer();
  mock.method(S3Client.prototype, "send", async (command) => {
    const { Key: key, Body: body } = command.input;
    switch (command.constructor.name) {
      case "PutObjectCommand":
        stored.set(key, Buffer.from(body));
        return {};
      case "GetObjectCommand":
        if (!stored.has(key)) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        return { Body: { transformToByteArray: async () => new Uint8Array(stored.get(key)) }, ContentType: "image/jpeg" };
      case "DeleteObjectCommand":
        stored.delete(key);
        return {};
      default:
        throw new Error(`Unexpected storage command ${command.constructor.name}`);
    }
  });
});

after(() => {
  setRekognitionClientForTests(null);
  mock.restoreAll();
  for (const key of Object.keys(environment)) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

const rekognitionFace = (face) => ({
  BoundingBox: { Left: face.left, Top: face.top, Width: face.width, Height: face.height },
  Confidence: 99.5,
  Quality: { Sharpness: 80, Brightness: 70 },
});
const rekognitionWord = (item) => ({
  Type: "WORD",
  DetectedText: item.text,
  Confidence: item.confidence,
  Geometry: { BoundingBox: { Left: item.box.left, Top: item.box.top, Width: item.box.width, Height: item.box.height } },
});

function recognition({ faces = GROUP_FACES, words = GROUP_WORDS, fail = false } = {}) {
  const calls = [];
  setRekognitionClientForTests({
    async send(command) {
      calls.push(command.constructor.name);
      if (fail) throw Object.assign(new Error("Simulated provider failure"), { name: "ThrottlingException" });
      if (command.constructor.name === "DetectFacesCommand") return { FaceDetails: faces.map(rekognitionFace) };
      if (command.constructor.name === "DetectTextCommand") return { TextDetections: words.map(rekognitionWord) };
      throw new Error(`Unexpected recognition command ${command.constructor.name}`);
    },
  });
  return calls;
}

async function databaseWithSentPhoto() {
  const prefix = "people-";
  const driver = new MemoryDynamoDriver(allTableDefinitions(prefix).map((table) => table.definition));
  const db = new DynamoDocumentDatabase({ driver, tablePrefix: prefix });
  const today = localDateKey(new Date());
  await db.collection("instructors").insertOne({ _id: "i9", name: "Meghana Rao", employee_id: "NW1000009", college_id: "c1", deleted_at: null });
  const key = `forms/c1/${today}/ph1.jpg`;
  stored.set(key, photoBytes);
  await db.collection("form_responses").insertOne({
    _id: "r1",
    college_id: "c1",
    form_date: today,
    status: "yes",
    submitted_by: "R",
    photos: [{ id: "ph1", key, thumb_key: `forms/c1/${today}/ph1-thumb.jpg`, width: 1280, height: 960, ...pendingPeopleFields() }],
    photo_links: [],
    source: "automatic",
    submitted_at: new Date(),
    updated_at: new Date(),
    edit_count: 0,
  });
  return db;
}

test("after a form is sent, the people in its photo are found, cut out, stored and named", async () => {
  const calls = recognition();
  const db = await databaseWithSentPhoto();
  const [before] = (await db.collection("form_responses").findOne({ _id: "r1" })).photos;
  assert.equal(peopleStatusView(before), "pending");
  assert.ok(photoNeedsReading(before));

  assert.equal(await readNextFormPhoto(db), true);
  const [photo] = (await db.collection("form_responses").findOne({ _id: "r1" })).photos;
  assert.equal(photo.people_status, "done");
  // "Meghana" is the institute's Meghana Rao; the others are kept as printed.
  assert.deepEqual(photo.people.map((person) => person.name), ["Bhumika", "Meghana Rao", "Sanjana", "Yugandhar", "Shreyansh"]);
  assert.deepEqual(photo.people.map((person) => person.instructor_id), [null, "i9", null, null, null]);
  assert.equal(photo.people[1].employee_id, "NW1000009");
  assert.equal(photo.people_worker, undefined, "the lease is cleared once read");
  for (const person of photo.people) {
    assert.match(person.crop_key, /^forms\/c1\/\d{4}-\d{2}-\d{2}\/ph1-[A-Za-z0-9_-]+\.jpg$/);
    const crop = await sharp(stored.get(person.crop_key)).metadata();
    assert.equal(crop.format, "jpeg");
    assert.ok(Math.max(crop.width, crop.height) <= 600);
  }
  assert.deepEqual(calls.sort(), ["DetectFacesCommand", "DetectTextCommand"], "faces are only found, never searched for");
  assert.equal(await readNextFormPhoto(db), false, "nothing left to read");

  const view = await serializeFormResponse(await db.collection("form_responses").findOne({ _id: "r1" }), { collegeName: "Aurora" });
  assert.equal(view.photos[0].people_status, "done");
  assert.equal(view.photos[0].people.length, 5);
});

test("a photo that cannot be read now is tried again later, then left as failed", async () => {
  recognition({ fail: true });
  const db = await databaseWithSentPhoto();
  let now = Date.now();
  for (let attempt = 1; attempt <= PEOPLE_MAX_ATTEMPTS; attempt += 1) {
    assert.equal(await readNextFormPhoto(db, now), true);
    const [photo] = (await db.collection("form_responses").findOne({ _id: "r1" })).photos;
    assert.equal(photo.people_attempts, attempt);
    if (attempt < PEOPLE_MAX_ATTEMPTS) {
      assert.equal(photo.people_status, "pending");
      assert.ok(!photoNeedsReading(photo, Date.now()), "waits before the next try");
      now = Number(photo.people_available_at) + 1;
    } else {
      assert.equal(photo.people_status, "failed");
      assert.equal(peopleStatusView(photo), "failed");
    }
  }
  assert.equal(await readNextFormPhoto(db, now + 60 * 60 * 1000), false, "a failed photo is not tried again");
});

test("a photo where no face is found is one person, the whole photo; old photos count as read", async () => {
  recognition({ faces: [], words: [] });
  const db = await databaseWithSentPhoto();
  assert.equal(await readNextFormPhoto(db), true);
  const [photo] = (await db.collection("form_responses").findOne({ _id: "r1" })).photos;
  assert.equal(photo.people_status, "done");
  assert.equal(photo.people.length, 1);
  assert.deepEqual(photo.people[0].box, WHOLE_PHOTO);
  assert.equal(photo.people[0].source, "none");
  assert.equal(peopleStatusView({ id: "old", key: "k", people: [] }), "done", "photos saved before this have their people already");
  assert.ok(!photoNeedsReading({ id: "old", key: "k", people: [] }));
});
