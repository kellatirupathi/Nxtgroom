import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { normalizeInstructorImage, PHOTO_MAX_BYTES } from "../src/imageProcessor.js";

test("stored photos retain detail above the former 2048 pixel cap and strip metadata", async () => {
  const input = await sharp({ create: { width: 3600, height: 2400, channels: 3, background: "#b0a080" } })
    .withMetadata().png().toBuffer();
  const result = await normalizeInstructorImage(input);
  const metadata = await sharp(result.buffer).metadata();
  assert.equal(result.width, 3072);
  assert.equal(result.height, 2048);
  assert.equal(metadata.exif, undefined);
  assert.ok(result.buffer.length <= PHOTO_MAX_BYTES);
  const small = await normalizeInstructorImage(await sharp(input).resize(600, 400).png().toBuffer());
  assert.equal(small.width, 600);
  assert.equal(small.height, 400);
});

test("high detail photos fit Rekognition's byte limit without enlarging the source", async () => {
  const pixels = randomBytes(3072 * 3072 * 3);
  const source = sharp(pixels, { raw: { width: 3072, height: 3072, channels: 3 } });
  const highQuality = await source.clone().jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
  assert.ok(highQuality.length > PHOTO_MAX_BYTES, "fixture must exercise oversized encoding");
  const result = await normalizeInstructorImage(await source.png().toBuffer());
  assert.ok(result.buffer.length <= PHOTO_MAX_BYTES);
  assert.ok(result.width <= 3072 && result.height <= 3072);
  assert.ok(result.width >= 320 && result.height >= 320);
});
