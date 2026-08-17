import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IMAGE_BYTES, validatePhoto } from '../src/imageValidation.ts';

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
