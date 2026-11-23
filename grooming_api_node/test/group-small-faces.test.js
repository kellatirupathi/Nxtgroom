import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import * as faceRecognition from "../src/services/faceRecognition.js";
import { GROUP_OUTCOMES, identifyPeopleInPhoto } from "../src/services/groupRecognition.js";
import { parseCaptureInfo } from "../src/services/captureInfo.js";
import { runtimeConfig } from "../src/config/env.js";

const CONFIGURED = {
  REKOGNITION_COLLECTION_ID: "facultytrack-faces-test",
  AWS_REKOGNITION_REGION: "ap-south-1",
  REKOGNITION_ACCESS_KEY_ID: "test-only-access-key-id",
  REKOGNITION_SECRET_ACCESS_KEY: "test-only-secret-access-key",
  GROUP_ATTENDANCE_MAX_PEOPLE: "6",
  GROUP_MIN_FACE_PIXELS: undefined,
};

// The kiosk tablet: a 1.2 megapixel camera, held on its side for a group.
const WIDTH = 1280;
const HEIGHT = 960;

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

async function tabletPhoto() {
  const pixels = Buffer.allocUnsafe(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 3;
      pixels[offset] = (x * 255) / WIDTH;
      pixels[offset + 1] = (y * 255) / HEIGHT;
      pixels[offset + 2] = (x + y) % 256;
    }
  }
  return sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).jpeg().toBuffer();
}

// A face given in pixels, as the face service would report it in fractions.
const face = (leftPx, topPx, widthPx, heightPx) => ({
  BoundingBox: { Left: leftPx / WIDTH, Top: topPx / HEIGHT, Width: widthPx / WIDTH, Height: heightPx / HEIGHT },
  Confidence: 99.5,
  Quality: { Sharpness: 70, Brightness: 65 },
  Pose: { Yaw: 2, Pitch: -1 },
});

// Three people standing head to feet in that picture: each about 880 px tall,
// which makes a face about 68 px wide and 91 px tall. The fourth is a
// passer-by at the back of the room.
const THREE_HEAD_TO_FEET = [face(180, 70, 68, 91), face(600, 74, 66, 90), face(1010, 72, 69, 92)];
const FAR_AWAY = face(880, 300, 40, 54);

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

const matched = (instructorId, similarity = 98.5) => ({
  FaceMatches: [{ Similarity: similarity, Face: { FaceId: `face-${instructorId}`, ExternalImageId: instructorId } }],
});

test.afterEach(() => faceRecognition.setRekognitionClientForTests(null));

test("three people standing head to feet on the kiosk tablet are all searched for", async () => {
  await withEnv(CONFIGURED, async () => {
    assert.equal(runtimeConfig().groupMinFacePixels, 48);
    const sent = stubRekognition({
      faceDetails: THREE_HEAD_TO_FEET,
      search: (index) => matched(`instructor-${index + 1}`),
    });

    const result = await identifyPeopleInPhoto(await tabletPhoto());

    assert.equal(result.ok, true);
    assert.equal(sent.filter((entry) => entry.name === "SearchFacesByImage").length, 3, "nobody is turned away unsearched");
    assert.deepEqual(result.people.map((person) => person.outcome), [
      GROUP_OUTCOMES.MATCHED,
      GROUP_OUTCOMES.MATCHED,
      GROUP_OUTCOMES.MATCHED,
    ]);
    assert.deepEqual(
      result.people.map((person) => person.instructorId).sort(),
      ["instructor-1", "instructor-2", "instructor-3"],
    );
  });
});

test("the same three people were all turned away as too far under the earlier floor of 72", async () => {
  await withEnv({ ...CONFIGURED, GROUP_MIN_FACE_PIXELS: "72" }, async () => {
    const sent = stubRekognition({
      faceDetails: THREE_HEAD_TO_FEET,
      search: (index) => matched(`instructor-${index + 1}`),
    });
    const result = await identifyPeopleInPhoto(await tabletPhoto());
    assert.equal(sent.filter((entry) => entry.name === "SearchFacesByImage").length, 0);
    assert.ok(result.people.every((person) => person.outcome === GROUP_OUTCOMES.TOO_SMALL));
  });
});

test("somebody really far from the camera is still told so, and costs no search", async () => {
  await withEnv(CONFIGURED, async () => {
    const sent = stubRekognition({
      faceDetails: [...THREE_HEAD_TO_FEET, FAR_AWAY],
      search: (index) => matched(`instructor-${index + 1}`),
    });
    const result = await identifyPeopleInPhoto(await tabletPhoto());
    assert.equal(sent.filter((entry) => entry.name === "SearchFacesByImage").length, 3);
    const far = result.people.find((person) => Math.abs(person.box.left - 880 / WIDTH) < 1e-9);
    assert.equal(far.outcome, GROUP_OUTCOMES.TOO_SMALL);
    assert.equal(far.instructorId, null);
  });
});

test("a smaller face is searched, but who it is still rests on the same match threshold", async () => {
  await withEnv(CONFIGURED, async () => {
    assert.equal(runtimeConfig().rekognitionMatchThreshold, 95);
    stubRekognition({
      faceDetails: THREE_HEAD_TO_FEET,
      search: (index) => (index === 1 ? matched("instructor-2", 91) : matched(`instructor-${index + 1}`)),
    });
    const result = await identifyPeopleInPhoto(await tabletPhoto());
    const outcomes = result.people.map((person) => person.outcome).sort();
    assert.deepEqual(outcomes, [GROUP_OUTCOMES.MATCHED, GROUP_OUTCOMES.MATCHED, GROUP_OUTCOMES.NO_MATCH]);
    const refused = result.people.find((person) => person.outcome === GROUP_OUTCOMES.NO_MATCH);
    assert.equal(refused.instructorId, null, "a 91% likeness is nobody");
  });
});

test("each person's own photograph is cut while the faces are searched, and stays with the right person", async () => {
  await withEnv(CONFIGURED, async () => {
    let searching = 0;
    let mostAtOnce = 0;
    stubRekognition({
      faceDetails: THREE_HEAD_TO_FEET,
      search: async (index) => {
        searching += 1;
        mostAtOnce = Math.max(mostAtOnce, searching);
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        searching -= 1;
        return matched(`instructor-${index + 1}`);
      },
    });
    const result = await identifyPeopleInPhoto(await tabletPhoto());
    assert.equal(mostAtOnce, 3, "the three searches run side by side");
    for (const person of result.people) {
      assert.equal(person.image.mimeType, "image/jpeg");
      assert.ok(person.image.buffer.length > 0);
      // The body crop is cut around this person's own face: about 3.4 face
      // widths plus a margin across, and never the whole photograph.
      const faceWidth = person.box.width * WIDTH;
      assert.ok(person.image.width > faceWidth * 3 && person.image.width < faceWidth * 5, `${person.image.width}px for a ${faceWidth}px face`);
      assert.ok(person.image.width < WIDTH);
    }
    const source = await readFile(new URL("../src/services/groupRecognition.js", import.meta.url), "utf8");
    assert.match(source, /const \[searches, bodies\] = await Promise\.all\(\[/);
    assert.equal((source.match(/personBodyCrop\(/g) || []).length, 1, "every body is cut once");
  });
});

test("the camera report of a group photograph keeps how the frame was chosen", () => {
  const info = parseCaptureInfo(JSON.stringify({
    source: "video",
    video: "1280x960",
    region: "1280x960",
    output: "1280x960",
    bytes: 412000,
    frames: 4,
    picked: 2,
    sharpness: 11.42,
    faces: "dropped",
    camera: { width: 1280, height: 960, maxWidth: 1280, maxHeight: 960, frameRate: 30 },
  }));
  assert.deepEqual(info, {
    source: "video",
    video: "1280x960",
    region: "1280x960",
    output: "1280x960",
    bytes: 412000,
    frames: 4,
    picked: 2,
    sharpness: 11.42,
    camera: { width: 1280, height: 960, maxWidth: 1280, maxHeight: 960, frameRate: 30 },
  });
});

test("the group route keeps the camera report on every record it writes, as the single route does", async () => {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  const start = source.indexOf("attendanceRouter.post(", source.indexOf("\"/auto/group\"") - 60);
  const end = source.indexOf("attendanceRouter.post(", start + 30);
  const group = source.slice(start, end);
  assert.match(group, /const captureInfo = parseCaptureInfo\(req\.body\?\.capture_info\);/);
  assert.match(group, /identification: identificationFor\(person\),\s*captureInfo,\s*now,/, "check-in");
  assert.match(group, /\.\.\.\(captureInfo \? \{ check_out_capture: captureInfo \} : \{\}\),/, "check-out");
  assert.ok(!group.includes("body_regions"), "body areas belong to one person, not to a group photograph");
});
