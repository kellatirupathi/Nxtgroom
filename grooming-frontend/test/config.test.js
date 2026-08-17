import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiBase } from '../src/config.ts';

test('production API base requires HTTPS', () => {
  assert.throws(() => normalizeApiBase('http://api.example.com', { production: true }), /HTTPS/);
  assert.equal(normalizeApiBase('https://api.example.com/', { production: true }), 'https://api.example.com');
});

test('API base rejects credentials and query strings', () => {
  assert.throws(() => normalizeApiBase('https://user:pass@api.example.com'), /credentials/);
  assert.throws(() => normalizeApiBase('https://api.example.com?secret=value'), /query/);
  assert.throws(() => normalizeApiBase('https://api.example.com/v1'), /without a path/);
});
