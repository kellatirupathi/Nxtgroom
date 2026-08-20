import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetchAllPages, normalizeApiError } from '../src/api.ts';

test('normalizes string and structured validation errors', () => {
  assert.equal(normalizeApiError({ detail: 'Not authorized' }), 'Not authorized');
  assert.equal(
    normalizeApiError({ detail: [{ loc: ['body', 'email'], msg: 'Invalid email' }] }),
    'body.email: Invalid email',
  );
});

test('collects every page, preserves query parameters, and deduplicates IDs', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  const pages = new Map([
    [0, [{ _id: 'a' }, { _id: 'b' }]],
    [2, [{ _id: 'b' }, { _id: 'c' }]],
    [4, [{ _id: 'd' }]],
  ]);
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    calls.push(url);
    const page = pages.get(Number(url.searchParams.get('offset'))) || [];
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const records = await apiFetchAllPages('/api/v2/attendance/today?date=2026-08-14', {
    auth: false,
    pageSize: 2,
    maxItems: 10,
  });

  assert.deepEqual(records.map((record) => record._id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(calls.map((url) => url.searchParams.get('offset')), ['0', '2', '4']);
  assert.ok(calls.every((url) => url.searchParams.get('limit') === '2'));
  assert.ok(calls.every((url) => url.searchParams.get('date') === '2026-08-14'));
});

test('fails explicitly when pagination exceeds its safety ceiling', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const offset = Number(new URL(input).searchParams.get('offset'));
    const page = offset === 0 ? [{ _id: 'a' }, { _id: 'b' }] : [{ _id: 'c' }];
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(
    apiFetchAllPages('/api/v2/instructors', { auth: false, pageSize: 2, maxItems: 2 }),
    /safety limit of 2 records/i,
  );
});

test('forwards caller cancellation across paginated requests', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input, { signal }) => new Promise((_resolve, reject) => {
    const cancel = () => reject(signal.reason || new Error('cancelled'));
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });

  const controller = new AbortController();
  const request = apiFetchAllPages('/api/v2/instructors', {
    auth: false,
    pageSize: 100,
    signal: controller.signal,
  });
  controller.abort(new Error('cancelled by test'));

  await assert.rejects(request, /timed out or was cancelled/i);
});

test('deduplicates concurrent cached pagination requests', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  globalThis.fetch = async () => {
    calls += 1;
    await fetchGate;
    return new Response(JSON.stringify([{ _id: 'shared' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const path = '/api/v2/instructors?include_feedback=false&request=dedupe-test';
  const options = { auth: false, pageSize: 2, cacheMs: 15_000 };
  const first = apiFetchAllPages(path, options);
  const second = apiFetchAllPages(path, options);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  releaseFetch();
  const [firstRecords, secondRecords] = await Promise.all([first, second]);
  assert.deepEqual(firstRecords, [{ _id: 'shared' }]);
  assert.deepEqual(secondRecords, firstRecords);
  assert.equal(calls, 1);
});
