import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReferencePhotoKey } from "../src/services/photoStorage.js";
import * as faceRecognition from "../src/services/faceRecognition.js";

function withEnv(values, run) {
  const original = {};
  for (const [key, value] of Object.entries(values)) {
    original[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function retiredFaceIds(mode, existingFaceIds) {
  return mode === "replace"
    ? existingFaceIds
    : faceRecognition.facesToEvict(existingFaceIds, { adding: 1 });
}

function resultingFaceIds(mode, existingFaceIds, newFaceId) {
  const retired = retiredFaceIds(mode, existingFaceIds);
  const kept = existingFaceIds.filter((id) => !retired.includes(id));
  return { retired, faceIds: [...kept, newFaceId] };
}

test("add keeps the existing faces alongside the new one", () => {
  withEnv({ REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "6" }, () => {
    const { retired, faceIds } = resultingFaceIds("add", ["face-1", "face-2"], "face-3");
    assert.deepEqual(retired, []);
    assert.deepEqual(faceIds, ["face-1", "face-2", "face-3"]);
  });
});

test("replace discards every earlier face and keeps only the new one", () => {
  withEnv({ REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "6" }, () => {
    const { retired, faceIds } = resultingFaceIds("replace", ["face-1", "face-2"], "face-3");
    assert.deepEqual(retired, ["face-1", "face-2"]);
    assert.deepEqual(faceIds, ["face-3"]);
  });
});

test("replace on an instructor with no face yet is just an add", () => {
  withEnv({ REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "6" }, () => {
    const { retired, faceIds } = resultingFaceIds("replace", [], "face-1");
    assert.deepEqual(retired, []);
    assert.deepEqual(faceIds, ["face-1"]);
  });
});

test("add at the cap retires the oldest face, never the newest", () => {
  withEnv({ REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "3" }, () => {
    const { retired, faceIds } = resultingFaceIds("add", ["oldest", "middle", "newest"], "fresh");
    assert.deepEqual(retired, ["oldest"]);
    assert.deepEqual(faceIds, ["middle", "newest", "fresh"]);
    assert.equal(faceIds.length, 3);
  });
});

test("a record already over the cap is trimmed back to it, oldest first", () => {
  withEnv({ REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "2" }, () => {
    const { retired, faceIds } = resultingFaceIds("add", ["a", "b", "c", "d"], "e");
    assert.deepEqual(retired, ["a", "b", "c"]);
    assert.deepEqual(faceIds, ["d", "e"]);
    assert.equal(faceIds.length, 2);
  });
});

test("every retired face is dropped from the record, so none is left searchable", () => {
  withEnv({ REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "3" }, () => {
    const existing = ["a", "b", "c"];
    for (const mode of ["add", "replace"]) {
      const { retired, faceIds } = resultingFaceIds(mode, existing, "new");
      for (const id of retired) {
        assert.ok(!faceIds.includes(id), `${mode}: retired ${id} must not remain on the record`);
      }
    }
  });
});

test("a reference photo is written outside the prefix the purge sweeps", () => {
  const key = buildReferencePhotoKey({ instructorId: "abc-123", mimeType: "image/jpeg" });
  assert.ok(key.startsWith("reference/"));
  assert.ok(!key.startsWith("attendance/"));
});

test("a replacement photo never collides with the photo it replaces", () => {
  const first = buildReferencePhotoKey({ instructorId: "abc-123", mimeType: "image/jpeg" });
  const second = buildReferencePhotoKey({ instructorId: "abc-123", mimeType: "image/jpeg" });
  assert.notEqual(first, second);
});

test("an instructor id that could escape its prefix is sanitised", () => {
  const key = buildReferencePhotoKey({ instructorId: "../../etc/passwd", mimeType: "image/jpeg" });
  assert.ok(key.startsWith("reference/"));
  assert.ok(!key.includes(".."));
  assert.ok(!key.includes("/etc/"));
});

test("the stored extension follows the normalised image type", () => {
  assert.ok(buildReferencePhotoKey({ instructorId: "i", mimeType: "image/jpeg" }).endsWith(".jpg"));
  assert.ok(buildReferencePhotoKey({ instructorId: "i", mimeType: "image/png" }).endsWith(".png"));
  assert.ok(buildReferencePhotoKey({ instructorId: "i", mimeType: "image/tiff" }).endsWith(".jpg"));
});
