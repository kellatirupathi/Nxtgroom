import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { GROUP_MAX_DIMENSION, normalizeGroupImage } from "../src/imageProcessor.js";
import * as faceRecognition from "../src/services/faceRecognition.js";
import { cropRegion, identifyPeopleInPhoto } from "../src/services/groupRecognition.js";
import { groupCaptureGate } from "../src/routes/attendanceRoutes.js";

/**
 * Group photographs at higher resolution, processed once.
 *
 * A group spends its pixels on several people, so the group path keeps its
 * photograph at up to 3072 on the long side where a single photograph stops at
 * 2048. It pays for that by never re-encoding the whole frame: the upload is
 * decoded once to pixels and every crop is cut from them. These tests pin both
 * halves - the resolution is really kept, and nothing is decoded twice - and
 * the memory gate that bounds how many such frames are held at once.
 */

const CONFIGURED = {
  REKOGNITION_COLLECTION_ID: "facultytrack-faces-test",
  AWS_REKOGNITION_REGION: "ap-south-1",
  REKOGNITION_ACCESS_KEY_ID: "test-only-access-key-id",
  REKOGNITION_SECRET_ACCESS_KEY: "test-only-secret-access-key",
  GROUP_ATTENDANCE_MAX_PEOPLE: "6",
  GROUP_MIN_FACE_PIXELS: "72",
};

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

/** A textured photograph, so crops of different places differ. */
async function photo(width, height, { channels = 3 } = {}) {
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      pixels[offset] = (x * 255) / width;
      if (channels === 3) {
        pixels[offset + 1] = (y * 255) / height;
        pixels[offset + 2] = (x + y) % 256;
      }
    }
  }
  return sharp(pixels, { raw: { width, height, channels } }).jpeg({ quality: 90 }).toBuffer();
}

test.afterEach(() => faceRecognition.setRekognitionClientForTests(null));

test("a group photograph is kept at up to 3072, where a single one stops at 2048", async () => {
  const large = await normalizeGroupImage(await photo(4000, 3000));
  assert.equal(large.width, GROUP_MAX_DIMENSION);
  assert.equal(large.height, 2304, "the aspect ratio is kept");
  assert.equal(large.channels, 3);
  assert.equal(large.data.length, large.width * large.height * 3, "pixels, not an encoded image");

  // Nothing is enlarged: a small photograph stays its own size.
  const small = await normalizeGroupImage(await photo(1654, 1080));
  assert.equal(small.width, 1654);
  assert.equal(small.height, 1080);
});

test("a greyscale upload still produces colour pixels, so every crop is an ordinary JPEG", async () => {
  const grey = await normalizeGroupImage(await photo(800, 600, { channels: 1 }));
  assert.equal(grey.channels, 3);
});

test("the group decoder refuses what the single one refuses", async () => {
  await assert.rejects(() => normalizeGroupImage(Buffer.alloc(0)), /empty/);
  const tiny = await photo(200, 200);
  await assert.rejects(() => normalizeGroupImage(tiny), /at least 320x320/);
  await assert.rejects(() => normalizeGroupImage(Buffer.from("not an image")));
});

test("a crop is cut from pixels at full resolution and encoded once", async () => {
  const pixels = await normalizeGroupImage(await photo(3072, 2007));
  const crop = await cropRegion(pixels, { left: 1000, top: 200, width: 900, height: 1700 });
  assert.equal(crop.width, 900);
  assert.equal(crop.height, 1700);
  assert.equal(crop.mimeType, "image/jpeg");
  const meta = await sharp(crop.buffer).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.channels, 3);

  // A rectangle running off the edge is trimmed rather than refused.
  const edge = await cropRegion(pixels, { left: 3000, top: 1900, width: 500, height: 500 });
  assert.equal(edge.width, 72);
  assert.equal(edge.height, 107);
});

test("faces are measured against the pixels kept, not a caller's dimensions", async () => {
  // 0.03 of 3072 is 92px - searchable. The same box at 2048 would be 61px,
  // below the floor. Measuring against the real pixels is what lets the extra
  // resolution reach the people at the back.
  await withEnv(CONFIGURED, async () => {
    const sent = [];
    faceRecognition.setRekognitionClientForTests({
      async send(command) {
        const name = command?.constructor?.name?.replace(/Command$/, "") ?? "";
        sent.push({ name, input: command.input });
        if (name === "DetectFaces") {
          return {
            FaceDetails: [{
              BoundingBox: { Left: 0.4, Top: 0.2, Width: 0.03, Height: 0.045 },
              Confidence: 99.5,
              Quality: { Sharpness: 70, Brightness: 65 },
            }],
          };
        }
        return { FaceMatches: [{ Similarity: 98.5, Face: { FaceId: "f1", ExternalImageId: "instructor-1" } }] };
      },
    });

    const pixels = await normalizeGroupImage(await photo(3072, 2007));
    // Deliberately wrong dimensions from the caller: they must be ignored.
    const result = await identifyPeopleInPhoto(pixels, { width: 2048, height: 1338 });

    assert.equal(result.ok, true);
    assert.equal(result.people[0].outcome, "MATCHED", "a 92px face is searched for");
    const detect = sent.find((entry) => entry.name === "DetectFaces");
    const detectMeta = await sharp(detect.input.Image.Bytes).metadata();
    assert.equal(detectMeta.width, 3072, "faces are found in the full-resolution image");
    const search = sent.find((entry) => entry.name === "SearchFacesByImage");
    const searchMeta = await sharp(search.input.Image.Bytes).metadata();
    assert.ok(searchMeta.width >= 180, `the face crop sent to search was only ${searchMeta.width}px`);
  });
});

test("a detection image over Rekognition's size limit is sent smaller, never refused", async () => {
  // Pure noise barely compresses: a 3072-square frame of it is far over 5MB as
  // a JPEG. The boxes come back as ratios, so they still fit the full pixels.
  await withEnv(CONFIGURED, async () => {
    const sent = [];
    faceRecognition.setRekognitionClientForTests({
      async send(command) {
        const name = command?.constructor?.name?.replace(/Command$/, "") ?? "";
        sent.push({ name, input: command.input });
        return name === "DetectFaces" ? { FaceDetails: [] } : {};
      },
    });
    const noise = Buffer.alloc(3072 * 3072 * 3);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) >>> 24;
    const pixels = { data: noise, width: 3072, height: 3072, channels: 3 };

    await identifyPeopleInPhoto(pixels);

    const bytes = sent.find((entry) => entry.name === "DetectFaces").input.Image.Bytes;
    assert.ok(bytes.length <= 4.5 * 1024 * 1024, `detection image was ${(bytes.length / 1048576).toFixed(1)}MB`);
    const meta = await sharp(bytes).metadata();
    assert.equal(Math.max(meta.width, meta.height), 2048);
  });
});

test("the group route decodes with the group decoder, and the single route is untouched", async () => {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  const slice = (path) => {
    const name = source.indexOf(`"${path}"`);
    const start = source.lastIndexOf("attendanceRouter.post(", name);
    const after = source.indexOf("attendanceRouter.post(", name + path.length);
    return source.slice(start, after);
  };
  const group = slice("/auto/group");
  assert.ok(group.includes("normalizeGroupImage(req.file.buffer)"));
  assert.ok(!group.includes("normalizeInstructorImage("), "the group route must not re-encode its frame");
  assert.ok(group.includes("identifyPeopleInPhoto(groupImage)"));
  const registration = group.slice(0, group.indexOf("asyncRoute("));
  assert.ok(registration.includes("groupCaptureGate"), "group photographs must pass their own memory gate");

  const single = slice("/auto");
  assert.ok(single.includes("normalizeInstructorImage(req.file.buffer)"));
  assert.ok(!single.includes("normalizeGroupImage"), "the single route keeps its own decoder");
  assert.ok(!single.includes("groupCaptureGate"));
});

/** Just enough of an Express response for a gate. */
function fakeResponse() {
  const listeners = new Map();
  return {
    statusCode: 200,
    body: null,
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    once(event, handler) { listeners.set(event, handler); },
    off(event) { listeners.delete(event); },
    emit(event) { listeners.get(event)?.(); },
  };
}

test("no more than two group photographs are held at once, and each slot is released", async () => {
  await withEnv({ GROUP_CONCURRENCY_LIMIT: undefined }, async () => {
    const admitted = [];
    const responses = [fakeResponse(), fakeResponse(), fakeResponse()];
    for (const res of responses) groupCaptureGate({}, res, () => admitted.push(res));

    assert.equal(admitted.length, 2, "the default limit is two");
    assert.equal(responses[2].statusCode, 503);
    assert.equal(responses[2].headers["Retry-After"], "5");
    assert.match(responses[2].body.detail, /retry/i);

    // A finished request frees its slot, and only once however it ends.
    responses[0].emit("finish");
    responses[0].emit("close");
    const next = fakeResponse();
    groupCaptureGate({}, next, () => admitted.push(next));
    assert.equal(admitted.length, 3);

    for (const res of [responses[1], next]) res.emit("close");
  });
});

import { normalizeInstructorImage } from "../src/imageProcessor.js";

test("a full-resolution photograph is re-saved faithfully, with the fast encoder", async () => {
  // Photographs arrive as 2048-pixel stills now. mozjpeg took ~1s of CPU per
  // one - five seconds at the tablet on a fifth of a CPU - and kept less of the
  // picture than the standard encoder does. This pins both halves of why it
  // was replaced: the encoder, and that fidelity did not go down with it.
  const source = await readFile(new URL("../src/imageProcessor.js", import.meta.url), "utf8");
  assert.ok(!source.includes("mozjpeg: true"), "the slow encoder is back in the photo path");

  const original = await photo(2048, 1536);
  const normalized = await normalizeInstructorImage(original);
  const [a, b] = await Promise.all([
    sharp(original).raw().toBuffer(),
    sharp(normalized.buffer).raw().toBuffer(),
  ]);
  let squaredError = 0;
  for (let i = 0; i < a.length; i += 1) squaredError += (a[i] - b[i]) ** 2;
  const psnr = 10 * Math.log10((255 * 255) / (squaredError / a.length));
  assert.ok(psnr >= 38, `re-saving lost too much of the picture: ${psnr.toFixed(1)} dB`);
  assert.equal(normalized.width, 2048, "a 2048-pixel still is kept at full size");
});
