import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import * as faceRecognition from "../src/services/faceRecognition.js";
import { GROUP_OUTCOMES, identifyPeopleInPhoto } from "../src/services/groupRecognition.js";

/**
 * Identifying several people from one photograph.
 *
 * The single-person route asks Rekognition one question. That API answers about
 * the largest face it can see and ignores every other one, so the interesting
 * claim here is mechanical rather than clever: each face must be cut out and
 * asked about separately, or five of six people are silently dropped.
 *
 * The stub records every command the SDK would have sent, so "one search per
 * person, each about a different picture" is checked against the actual bytes
 * rather than against a count.
 *
 * sharp is real. The crops are the crops that would be uploaded and analysed,
 * which is the only way a rectangle that sharp refuses shows up in a test
 * rather than at a tablet.
 */

const CONFIGURED = {
  REKOGNITION_COLLECTION_ID: "facultytrack-faces-test",
  AWS_REKOGNITION_REGION: "ap-south-1",
  REKOGNITION_ACCESS_KEY_ID: "test-only-access-key-id",
  REKOGNITION_SECRET_ACCESS_KEY: "test-only-secret-access-key",
  GROUP_ATTENDANCE_MAX_PEOPLE: "6",
  GROUP_MIN_FACE_PIXELS: "72",
};

const WIDTH = 1600;
const HEIGHT = 1200;

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

/**
 * A real photograph, so every crop is really taken.
 *
 * Textured rather than flat, and deliberately so: five crops of a uniform grey
 * rectangle encode to identical bytes however far apart they were taken from,
 * which would let "each person was cropped separately" pass against code that
 * cropped nothing at all. The gradient makes every region of the frame
 * distinguishable from every other.
 */
async function groupPhoto() {
  const pixels = Buffer.allocUnsafe(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 3;
      pixels[offset] = (x * 255) / WIDTH;
      pixels[offset + 1] = (y * 255) / HEIGHT;
      pixels[offset + 2] = ((x + y) % 256);
    }
  }
  return sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .jpeg()
    .toBuffer();
}

/** One detected face, as Rekognition reports it. */
const detected = (left, top, width = 0.07, height = 0.09, confidence = 99.5) => ({
  BoundingBox: { Left: left, Top: top, Width: width, Height: height },
  Confidence: confidence,
  Quality: { Sharpness: 70, Brightness: 65 },
  Pose: { Yaw: 2, Pitch: -1 },
});

/** Five people standing in a line, left to right. */
const FIVE_IN_A_ROW = [
  detected(0.06, 0.18),
  detected(0.24, 0.18),
  detected(0.42, 0.18),
  detected(0.60, 0.18),
  detected(0.78, 0.18),
];

/**
 * Installs the stub and returns what it was asked.
 *
 * `search` is given the call index, so each face can be answered differently —
 * which is the whole point: a single canned reply would pass even if the code
 * searched once and copied the answer five times.
 */
function stubRekognition({ faceDetails, search }) {
  const sent = [];
  faceRecognition.setRekognitionClientForTests({
    async send(command) {
      const name = command?.constructor?.name?.replace(/Command$/, "") ?? "";
      sent.push({ name, input: command.input });
      if (name === "DetectFaces") return { FaceDetails: faceDetails };
      if (name === "SearchFacesByImage") {
        const index = sent.filter((entry) => entry.name === "SearchFacesByImage").length - 1;
        return search(index, command.input);
      }
      return {};
    },
  });
  return sent;
}

/** A match at a believable score. */
const matched = (instructorId, similarity = 98.5) => ({
  FaceMatches: [{
    Similarity: similarity,
    Face: { FaceId: `face-${instructorId}`, ExternalImageId: instructorId },
  }],
});

const NO_MATCH = { FaceMatches: [] };

test.afterEach(() => faceRecognition.setRekognitionClientForTests(null));

test("every person in the photograph is searched for, on their own crop", async () => {
  await withEnv(CONFIGURED, async () => {
    const sent = stubRekognition({
      faceDetails: FIVE_IN_A_ROW,
      search: (index) => matched(`instructor-${index}`),
    });

    const result = await identifyPeopleInPhoto(await groupPhoto(), { width: WIDTH, height: HEIGHT });

    assert.equal(result.ok, true);
    assert.equal(result.people.length, 5);

    const searches = sent.filter((entry) => entry.name === "SearchFacesByImage");
    assert.equal(searches.length, 5, "one search per person, not one for the photograph");
    assert.equal(
      sent.filter((entry) => entry.name === "DetectFaces").length,
      1,
      "the group is detected once and only once",
    );

    // The bytes must differ, or the code cropped nothing and searched the same
    // picture five times — which would return the same person five times and
    // look, from the counts alone, exactly like this test passing.
    const fingerprints = new Set(searches.map((entry) => entry.input.Image.Bytes.toString("base64")));
    assert.equal(fingerprints.size, 5, "each search must be about a different crop");

    // Threshold and collection are the single-person route's, unchanged.
    for (const search of searches) {
      assert.equal(search.input.CollectionId, CONFIGURED.REKOGNITION_COLLECTION_ID);
      assert.equal(search.input.FaceMatchThreshold, 95);
    }

    assert.deepEqual(
      result.people.map((person) => person.instructorId),
      ["instructor-0", "instructor-1", "instructor-2", "instructor-3", "instructor-4"],
    );
    for (const person of result.people) {
      assert.equal(person.outcome, GROUP_OUTCOMES.MATCHED);
      assert.ok(person.image?.buffer?.length > 0, "every person needs bytes to analyse");
      assert.equal(person.image.mimeType, "image/jpeg");
    }
  });
});

test("the body crop analysed is not the group photograph", async () => {
  await withEnv(CONFIGURED, async () => {
    stubRekognition({
      faceDetails: FIVE_IN_A_ROW,
      search: (index) => matched(`instructor-${index}`),
    });
    const photo = await groupPhoto();
    const result = await identifyPeopleInPhoto(photo, { width: WIDTH, height: HEIGHT });

    for (const person of result.people) {
      const meta = await sharp(person.image.buffer).metadata();
      assert.ok(meta.width < WIDTH, "a crop as wide as the group is not a crop");
      assert.ok(
        meta.height > meta.width,
        "a standing person's crop should be taller than it is wide",
      );
    }

    // Different people, different crops: six identical reports is the failure
    // this whole feature exists to avoid.
    const sizes = new Set(result.people.map((person) => person.image.buffer.toString("base64")));
    assert.equal(sizes.size, 5);
  });
});

test("two faces matching one instructor are both refused, not resolved by score", async () => {
  await withEnv(CONFIGURED, async () => {
    // A look-alike above the threshold scores like a genuine match, so the
    // higher score is not evidence of which of the two is the real person.
    stubRekognition({
      faceDetails: [detected(0.1, 0.2), detected(0.5, 0.2), detected(0.8, 0.2)],
      search: (index) => {
        if (index === 0) return matched("instructor-twin", 97.1);
        if (index === 1) return matched("instructor-twin", 99.4);
        return matched("instructor-other", 98.0);
      },
    });

    const result = await identifyPeopleInPhoto(await groupPhoto(), { width: WIDTH, height: HEIGHT });

    const twins = result.people.filter((person) => person.outcome === GROUP_OUTCOMES.AMBIGUOUS);
    assert.equal(twins.length, 2, "both claims on one identity must be demoted");
    for (const twin of twins) {
      assert.equal(twin.instructorId, null, "an ambiguous match must not carry a name");
      assert.equal(twin.similarity, null);
      assert.ok(twin.image, "they are still recorded, for an administrator to name");
    }
    const other = result.people.find((person) => person.outcome === GROUP_OUTCOMES.MATCHED);
    assert.equal(other.instructorId, "instructor-other", "the third person is unaffected");
  });
});

test("a face too small to identify is reported, not searched for", async () => {
  await withEnv(CONFIGURED, async () => {
    // 0.02 of 1600px is 32px across — far below the floor. Searching it would
    // either be refused by Rekognition or, worse, match somebody on a handful
    // of blurred features.
    const sent = stubRekognition({
      faceDetails: [detected(0.10, 0.20, 0.02, 0.025), detected(0.50, 0.20)],
      search: () => matched("instructor-near"),
    });

    const result = await identifyPeopleInPhoto(await groupPhoto(), { width: WIDTH, height: HEIGHT });

    assert.equal(
      sent.filter((entry) => entry.name === "SearchFacesByImage").length,
      1,
      "the distant face must not cost a search",
    );
    const [far, near] = result.people;
    assert.equal(far.outcome, GROUP_OUTCOMES.TOO_SMALL);
    assert.equal(far.instructorId, null);
    assert.equal(near.outcome, GROUP_OUTCOMES.MATCHED);
  });
});

test("an unmatched face still comes back with bytes to record", async () => {
  await withEnv(CONFIGURED, async () => {
    stubRekognition({
      faceDetails: [detected(0.2, 0.2), detected(0.6, 0.2)],
      search: (index) => (index === 0 ? matched("instructor-known") : NO_MATCH),
    });

    const result = await identifyPeopleInPhoto(await groupPhoto(), { width: WIDTH, height: HEIGHT });
    const stranger = result.people[1];

    assert.equal(stranger.outcome, GROUP_OUTCOMES.NO_MATCH);
    assert.equal(stranger.instructorId, null);
    assert.ok(
      stranger.image?.buffer?.length > 0,
      "an unidentified record is still a record of somebody who turned up",
    );
  });
});

test("more people than the cap is refused whole, before anything is spent", async () => {
  await withEnv({ ...CONFIGURED, GROUP_ATTENDANCE_MAX_PEOPLE: "4" }, async () => {
    const sent = stubRekognition({
      faceDetails: FIVE_IN_A_ROW,
      search: () => matched("instructor-any"),
    });

    const result = await identifyPeopleInPhoto(await groupPhoto(), { width: WIDTH, height: HEIGHT });

    assert.equal(result.ok, false);
    assert.equal(result.detected, 5);
    assert.match(result.message, /at most 4/);
    assert.equal(
      sent.filter((entry) => entry.name === "SearchFacesByImage").length,
      0,
      "recording four of five people is worse than recording none and saying so",
    );
  });
});

test("a low-confidence detection is dropped rather than searched for", async () => {
  await withEnv(CONFIGURED, async () => {
    // A face on a poster, or a pattern on a wall. Searching it can only produce
    // an unidentified record nobody is able to resolve.
    const sent = stubRekognition({
      faceDetails: [detected(0.2, 0.2, 0.07, 0.09, 55), detected(0.6, 0.2)],
      search: () => matched("instructor-real"),
    });

    const result = await identifyPeopleInPhoto(await groupPhoto(), { width: WIDTH, height: HEIGHT });

    assert.equal(result.people.length, 1);
    assert.equal(sent.filter((entry) => entry.name === "SearchFacesByImage").length, 1);
  });
});

test("an empty frame and an unreachable provider are reported, never thrown", async () => {
  await withEnv(CONFIGURED, async () => {
    stubRekognition({ faceDetails: [], search: () => NO_MATCH });
    const empty = await identifyPeopleInPhoto(await groupPhoto(), { width: WIDTH, height: HEIGHT });
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, "NO_FACE");
  });

  await withEnv(CONFIGURED, async () => {
    faceRecognition.setRekognitionClientForTests({
      async send() {
        const error = new Error("network down");
        error.name = "ServiceUnavailableException";
        throw error;
      },
    });
    const down = await identifyPeopleInPhoto(await groupPhoto(), { width: WIDTH, height: HEIGHT });
    assert.equal(down.ok, false);
    assert.equal(down.reason, "PROVIDER_ERROR");
  });
});

test("an unconfigured collection reports itself instead of throwing", async () => {
  await withEnv({ ...CONFIGURED, REKOGNITION_COLLECTION_ID: "" }, async () => {
    const result = await identifyPeopleInPhoto(await groupPhoto(), { width: WIDTH, height: HEIGHT });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "NOT_CONFIGURED");
  });
});
