import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * sessionStorage does not exist in Node, and api.ts reads it at call time, so a
 * minimal stand-in must be installed before the module is imported.
 */
function installSessionStorage() {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    get length() { return store.size; },
    key: (index) => [...store.keys()][index] ?? null,
  };
  // Object.keys(sessionStorage) is how dropPersisted() enumerates entries.
  return store;
}

const store = installSessionStorage();
const { primeCache, readStale, invalidateCache, clearRequestCache } = await import('../src/api.ts');

test('primed values are readable as stale data', () => {
  clearRequestCache();
  primeCache('/api/v2/colleges', [{ _id: 'c1', name: 'Campus A' }]);
  const cached = readStale('/api/v2/colleges');
  assert.equal(Array.isArray(cached), true);
  assert.equal(cached[0].name, 'Campus A');
});

test('invalidating a prefix removes the cached value', () => {
  clearRequestCache();
  primeCache('/api/v2/colleges', [{ _id: 'c1' }]);
  invalidateCache('/api/v2/colleges');
  assert.equal(readStale('/api/v2/colleges'), undefined);
});

test('a stale in-memory entry is still returned for first paint', async () => {
  clearRequestCache();
  // A zero lifetime expires immediately, but the value must survive for the
  // instant-render path; only apiFetchCached() treats it as too old to reuse.
  primeCache('/api/v2/instructors', [{ _id: 'i1' }], 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const cached = readStale('/api/v2/instructors');
  assert.equal(Array.isArray(cached), true, 'expired entries should still paint');
  assert.equal(cached[0]._id, 'i1');
});

test('clearing the cache wipes persisted copies so a logout leaks nothing', () => {
  clearRequestCache();
  primeCache('/api/v2/boas', [{ _id: 'b1', email: 'someone@example.com' }]);
  assert.notEqual(readStale('/api/v2/boas'), undefined);

  clearRequestCache();
  assert.equal(readStale('/api/v2/boas'), undefined);
  const leaked = [...store.keys()].filter((key) => key.startsWith('ft_cache:'));
  assert.deepEqual(leaked, [], 'no cached payload may survive a session clear');
});
