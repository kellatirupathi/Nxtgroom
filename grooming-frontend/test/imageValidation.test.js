import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IMAGE_BYTES, MAX_SOURCE_BYTES, validatePhoto, validateSourcePhoto } from '../src/imageValidation.ts';

test('accepts supported photos within the upload limit', () => {
  assert.equal(validatePhoto({ type: 'image/jpeg', size: 1024 }), '');
  assert.equal(validatePhoto({ type: 'image/webp', size: MAX_IMAGE_BYTES }), '');
});

test('rejects empty, unsupported, and oversized photos', () => {
  assert.match(validatePhoto(null), /Select/);
  assert.match(validatePhoto({ type: 'image/gif', size: 1024 }), /JPEG/);
  assert.match(validatePhoto({ type: 'image/png', size: 0 }), /empty/);
  assert.match(validatePhoto({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 }), /8 MB/);
});

test('a large phone photo passes source validation so it can be downscaled', () => {
  // The bug this covers: an 11 MB 12MP capture was rejected at selection,
  // before the browser shrank it to roughly 400 KB. Real users could not
  // check in at all from a modern phone.
  const phonePhoto = { type: 'image/jpeg', size: 11 * 1024 * 1024 };
  assert.equal(validateSourcePhoto(phonePhoto), '', 'must reach the downscaler');
  assert.match(validatePhoto(phonePhoto), /8 MB/, 'still refused if never shrunk');
});

test('source validation accepts HEIC and unknown camera types', () => {
  assert.equal(validateSourcePhoto({ type: 'image/heic', size: 4 * 1024 * 1024 }), '');
  // Some Android pickers report no type at all for a camera capture.
  assert.equal(validateSourcePhoto({ type: '', size: 2 * 1024 * 1024 }), '');
});

test('source validation still rejects non-images, empties, and absurd sizes', () => {
  assert.match(validateSourcePhoto(null), /Select/);
  assert.match(validateSourcePhoto({ type: 'application/pdf', size: 1024 }), /JPEG/);
  assert.match(validateSourcePhoto({ type: 'image/jpeg', size: 0 }), /empty/);
  assert.match(
    validateSourcePhoto({ type: 'image/jpeg', size: MAX_SOURCE_BYTES + 1 }),
    /unusually large/,
  );
});
