import assert from "node:assert/strict";
import { test } from "node:test";
import * as faceRecognition from "../src/services/faceRecognition.js";
import { enrollReferencePhoto } from "../src/services/referencePhotos.js";

const configured = {
  REKOGNITION_COLLECTION_ID: "facultytrack-faces-test",
  AWS_REKOGNITION_REGION: "ap-south-1",
  REKOGNITION_ACCESS_KEY_ID: "test-access-key-id",
  REKOGNITION_SECRET_ACCESS_KEY: "test-secret-access-key",
  R2_ENDPOINT: "",
  R2_BUCKET: "",
  R2_ACCESS_KEY_ID: "",
  R2_SECRET_ACCESS_KEY: "",
};

async function withEnv(values, run) {
  const original = {};
  for (const [key, value] of Object.entries(values)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function stubRekognition(responses) {
  const sent = [];
  faceRecognition.setRekognitionClientForTests({
    async send(command) {
      const name = command.constructor.name.replace(/Command$/, "");
      sent.push(name);
      return responses[name] ?? {};
    },
  });
  return sent;
}

function recordingDb() {
  const writes = [];
  return {
    writes,
    collection(name) {
      return {
        updateOne: async (...args) => {
          writes.push({ name, args });
          return { matchedCount: 1 };
        },
      };
    },
  };
}

const instructor = { _id: "instructor-1", face_ids: [] };
const normalized = { buffer: Buffer.from("jpeg-bytes"), mimeType: "image/jpeg" };

test("a photograph with no face is refused with 422 and nothing is written", async () => {
  await withEnv(configured, async () => {
    const sent = stubRekognition({ DetectFaces: { FaceDetails: [] } });
    const db = recordingDb();
    const result = await enrollReferencePhoto(db, instructor, normalized);
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.equal(result.reason, "NO_FACE");
    assert.match(result.detail, /No face/);
    assert.deepEqual(sent, ["DetectFaces"]);
    assert.equal(db.writes.length, 0);
  });
  faceRecognition.setRekognitionClientForTests(null);
});

test("a provider outage is a 503, so the admin is told to retry rather than retake", async () => {
  await withEnv(configured, async () => {
    faceRecognition.setRekognitionClientForTests({
      async send() { throw Object.assign(new Error("down"), { name: "ServiceUnavailable" }); },
    });
    const result = await enrollReferencePhoto(recordingDb(), instructor, normalized);
    assert.equal(result.status, 503);
    assert.equal(result.reason, "PROVIDER_ERROR");
  });
  faceRecognition.setRekognitionClientForTests(null);
});

test("an already checked photograph skips the second quality check", async () => {
  await withEnv(configured, async () => {
    const sent = stubRekognition({});
    const db = recordingDb();
    const result = await enrollReferencePhoto(db, instructor, normalized, {
      checkedQuality: { sharpness: 80, brightness: 70, confidence: 99 },
    });
    assert.deepEqual(sent, []);
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.match(result.detail, /could not be stored/);
    assert.equal(result.reason, undefined);
    assert.equal(db.writes.length, 0);
  });
  faceRecognition.setRekognitionClientForTests(null);
});
