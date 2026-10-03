import assert from "node:assert/strict";
import { test } from "node:test";
import * as faceRecognition from "../src/services/faceRecognition.js";

const COLLECTION = "facultytrack-faces-test";

function loadService({ responses = {}, failures = {} } = {}) {
  const sent = [];
  const nameOf = (command) => command?.constructor?.name
    ?.replace(/Command$/, "")
    ?? "";

  faceRecognition.setRekognitionClientForTests({
    async send(command) {
      sent.push(Object.assign(command, { commandName: nameOf(command) }));
      const key = nameOf(command);
      if (failures[key]) throw failures[key];
      return responses[key] ?? {};
    },
  });

  return { ...faceRecognition, sent };
}

const faceMatch = (instructorId, similarity, faceId = `face-${instructorId}-${similarity}`) => ({
  Similarity: similarity,
  Face: { FaceId: faceId, ExternalImageId: instructorId },
});

const goodQuality = {
  FaceDetails: [{ Confidence: 99.9, Quality: { Sharpness: 80, Brightness: 70 } }],
};

const imageBytes = Buffer.from("not-a-real-jpeg-only-bytes-for-the-stub");

async function withEnv(values, run) {
  const original = {};
  for (const [key, value] of Object.entries(values)) {
    original[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
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

const configured = {
  REKOGNITION_COLLECTION_ID: COLLECTION,
  AWS_REKOGNITION_REGION: "ap-south-1",
  REKOGNITION_ACCESS_KEY_ID: "test-access-key-id",
  REKOGNITION_SECRET_ACCESS_KEY: "test-secret-access-key",
};

test.afterEach(() => {
  faceRecognition.setRekognitionClientForTests(null);
});

test("an unconfigured collection reports itself instead of throwing", async () => {
  await withEnv({ ...configured, REKOGNITION_COLLECTION_ID: "" }, async () => {
    const service = await loadService();
    assert.equal(service.isFaceRecognitionConfigured(), false);
    for (const result of [
      await service.searchFaceByImage(imageBytes),
      await service.checkFaceQuality(imageBytes),
      await service.indexFace(imageBytes, "instructor-1"),
      await service.deleteFaces(["face-1"]),
    ]) {
      assert.equal(result.ok, false);
      assert.equal(result.reason, "NOT_CONFIGURED");
    }
  });
});

test("identity comes from the instructor id, not from the face id", async () => {
  await withEnv(configured, async () => {
    const service = await loadService({
      responses: { SearchFacesByImage: { FaceMatches: [faceMatch("instructor-7", 98.2)] } },
    });
    const result = await service.searchFaceByImage(imageBytes);
    assert.equal(result.ok, true);
    assert.equal(result.instructorId, "instructor-7");
    assert.equal(result.similarity, 98.2);
  });
});

test("two embeddings of one person are one match, not an ambiguous pair", async () => {
  await withEnv(configured, async () => {
    const service = await loadService({
      responses: {
        SearchFacesByImage: {
          FaceMatches: [
            faceMatch("instructor-7", 97.1, "face-a"),
            faceMatch("instructor-7", 96.4, "face-b"),
            faceMatch("instructor-7", 95.8, "face-c"),
          ],
        },
      },
    });
    const result = await service.searchFaceByImage(imageBytes);
    assert.equal(result.ok, true);
    assert.equal(result.instructorId, "instructor-7");
    assert.equal(result.similarity, 97.1);
    assert.equal(result.runnerUp, null);
  });
});

test("the closest rival person is reported so look-alikes can be found later", async () => {
  await withEnv(configured, async () => {
    const service = await loadService({
      responses: {
        SearchFacesByImage: {
          FaceMatches: [faceMatch("instructor-7", 97.0), faceMatch("instructor-9", 96.2)],
        },
      },
    });
    const result = await service.searchFaceByImage(imageBytes);
    assert.equal(result.instructorId, "instructor-7");
    assert.deepEqual(result.runnerUp, { instructorId: "instructor-9", similarity: 96.2 });
  });
});

test("a score below the threshold is refused rather than offered as a guess", async () => {
  await withEnv({ ...configured, REKOGNITION_MATCH_THRESHOLD: "95" }, async () => {
    const service = await loadService({
      responses: { SearchFacesByImage: { FaceMatches: [faceMatch("instructor-7", 91.4)] } },
    });
    const result = await service.searchFaceByImage(imageBytes);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "BELOW_THRESHOLD");
    assert.equal(result.instructorId, undefined);
  });
});

test("the provider is asked to apply the threshold too", async () => {
  await withEnv({ ...configured, REKOGNITION_MATCH_THRESHOLD: "97" }, async () => {
    const service = await loadService({
      responses: { SearchFacesByImage: { FaceMatches: [faceMatch("instructor-7", 99)] } },
    });
    await service.searchFaceByImage(imageBytes);
    const search = service.sent.find((command) => command.commandName === "SearchFacesByImage");
    assert.equal(search.input.FaceMatchThreshold, 97);
    assert.equal(search.input.CollectionId, COLLECTION);
    assert.equal(search.input.QualityFilter, "LOW");
  });
});

test("no match and no face are distinguished", async () => {
  await withEnv(configured, async () => {
    const empty = await loadService({ responses: { SearchFacesByImage: { FaceMatches: [] } } });
    assert.equal((await empty.searchFaceByImage(imageBytes)).reason, "NO_MATCH");

    const noFace = await loadService({
      failures: {
        SearchFacesByImage: Object.assign(new Error("no face"), { name: "InvalidParameterException" }),
      },
    });
    assert.equal((await noFace.searchFaceByImage(imageBytes)).reason, "NO_FACE");
  });
});

test("a matched face with no instructor id is not a match", async () => {
  await withEnv(configured, async () => {
    const service = await loadService({
      responses: {
        SearchFacesByImage: {
          FaceMatches: [{ Similarity: 99, Face: { FaceId: "orphan-face" } }],
        },
      },
    });
    assert.equal((await service.searchFaceByImage(imageBytes)).reason, "NO_MATCH");
  });
});

test("a provider outage is reported, never thrown, so the check-in survives", async () => {
  await withEnv(configured, async () => {
    const service = await loadService({
      failures: {
        SearchFacesByImage: Object.assign(new Error("service down"), { name: "ThrottlingException" }),
      },
    });
    const result = await service.searchFaceByImage(imageBytes);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "PROVIDER_ERROR");
  });
});

test("a reference photograph needs exactly one good face", async () => {
  await withEnv(configured, async () => {
    const none = await loadService({ responses: { DetectFaces: { FaceDetails: [] } } });
    assert.equal((await none.checkFaceQuality(imageBytes)).reason, "NO_FACE");

    const many = await loadService({
      responses: { DetectFaces: { FaceDetails: [goodQuality.FaceDetails[0], goodQuality.FaceDetails[0]] } },
    });
    assert.equal((await many.checkFaceQuality(imageBytes)).reason, "MULTIPLE_FACES");

    const good = await loadService({ responses: { DetectFaces: goodQuality } });
    const accepted = await good.checkFaceQuality(imageBytes);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.quality.sharpness, 80);
  });
});

test("a blurry or dark reference photograph is refused before it is indexed", async () => {
  await withEnv(configured, async () => {
    const blurry = await loadService({
      responses: { DetectFaces: { FaceDetails: [{ Confidence: 99, Quality: { Sharpness: 3, Brightness: 70 } }] } },
    });
    assert.equal((await blurry.checkFaceQuality(imageBytes)).reason, "POOR_QUALITY");

    const dark = await loadService({
      responses: { DetectFaces: { FaceDetails: [{ Confidence: 99, Quality: { Sharpness: 80, Brightness: 4 } }] } },
    });
    assert.equal((await dark.checkFaceQuality(imageBytes)).reason, "POOR_QUALITY");
  });
});

test("indexing tags the face with the instructor id", async () => {
  await withEnv(configured, async () => {
    const service = await loadService({
      responses: { IndexFaces: { FaceRecords: [{ Face: { FaceId: "new-face-id" } }] } },
    });
    const result = await service.indexFace(imageBytes, "instructor-42");
    assert.equal(result.ok, true);
    assert.equal(result.faceId, "new-face-id");

    const command = service.sent.find((entry) => entry.commandName === "IndexFaces");
    assert.equal(command.input.ExternalImageId, "instructor-42");
    assert.equal(command.input.CollectionId, COLLECTION);
    assert.equal(command.input.MaxFaces, 1);
  });
});

test("an instructor id Rekognition cannot store is refused locally", async () => {
  await withEnv(configured, async () => {
    const service = await loadService();
    const result = await service.indexFace(imageBytes, "instructor 42/../etc");
    assert.equal(result.ok, false);
    assert.equal(service.sent.length, 0);
  });
});

test("an accepted request that indexed nothing is reported as a quality refusal", async () => {
  await withEnv(configured, async () => {
    const service = await loadService({ responses: { IndexFaces: { FaceRecords: [] } } });
    const result = await service.indexFace(imageBytes, "instructor-42");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "POOR_QUALITY");
  });
});

test("deleting no faces is a no-op that never calls the provider", async () => {
  await withEnv(configured, async () => {
    const service = await loadService();
    const result = await service.deleteFaces([]);
    assert.equal(result.ok, true);
    assert.equal(service.sent.length, 0);
  });
});

test("the oldest faces are evicted once the cap is reached", async () => {
  await withEnv({ ...configured, REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "3" }, async () => {
    const service = await loadService();
    assert.deepEqual(service.facesToEvict(["a", "b"], { adding: 1 }), []);
    assert.deepEqual(service.facesToEvict(["a", "b", "c"], { adding: 1 }), ["a"]);
    assert.deepEqual(service.facesToEvict(["a", "b", "c", "d"], { adding: 1 }), ["a", "b"]);
    assert.deepEqual(service.facesToEvict([], { adding: 1 }), []);
  });
});
