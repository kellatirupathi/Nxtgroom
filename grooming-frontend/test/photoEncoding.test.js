import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeUploadJpeg, PHOTO_JPEG_QUALITY, PHOTO_MAX_DIMENSION } from '../src/lib/photoEncoding.ts';
import { MAX_IMAGE_BYTES } from '../src/imageValidation.ts';
import { SINGLE_UPLOAD_MAX_DIMENSION } from '../src/lib/stillCapture.ts';

test('single photos preserve 3072 pixels and start at 95 percent quality', async () => {
  assert.equal(PHOTO_MAX_DIMENSION, 3072);
  assert.equal(SINGLE_UPLOAD_MAX_DIMENSION, PHOTO_MAX_DIMENSION);
  const calls = [];
  const blob = new Blob(['photo']);
  assert.equal(await encodeUploadJpeg({ toBlob(done, type, quality) { calls.push({ type, quality }); done(blob); } }), blob);
  assert.deepEqual(calls, [{ type: 'image/jpeg', quality: PHOTO_JPEG_QUALITY }]);
  assert.equal(PHOTO_JPEG_QUALITY, 0.95);
});

test('oversized uploads reduce quality only until they fit', async () => {
  const calls = [];
  const oversized = new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)]);
  const fitting = new Blob(['fits']);
  const result = await encodeUploadJpeg({ toBlob(done, _type, quality) {
    calls.push(quality);
    done(quality > 0.85 ? oversized : fitting);
  } });
  assert.equal(result, fitting);
  assert.deepEqual(calls, [0.95, 0.9, 0.85]);
});

test('failed encodes and photos that cannot fit fail explicitly', async () => {
  await assert.rejects(encodeUploadJpeg({ toBlob(done) { done(null); } }), /encoding failed/);
  const oversized = new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)]);
  await assert.rejects(encodeUploadJpeg({ toBlob(done) { done(oversized); } }), /8 MB/);
});
