import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cachedInstitute, publicFormPath, readCachedForm, rosterPath, writeCachedForm } from '../src/lib/formPrefetch.ts';

function withStorage(run) {
  const values = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  });
  try {
    return run(values);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
}

const data = (date, today = date) => ({
  institute: { name: 'Aurora University', location: 'Hyderabad' },
  date,
  today,
  limits: { max_photos: 5, max_file_mb: 10 },
  response: null,
});

test('the form data and the names are asked for at their own addresses', () => {
  assert.equal(publicFormPath('abcdefghijklmnopqrstuvwx', null), '/api/v2/forms/abcdefghijklmnopqrstuvwx');
  assert.equal(publicFormPath('abcdefghijklmnopqrstuvwx', '2026-11-24'), '/api/v2/forms/abcdefghijklmnopqrstuvwx?date=2026-11-24');
  assert.equal(rosterPath('abcdefghijklmnopqrstuvwx'), '/api/v2/forms/abcdefghijklmnopqrstuvwx/instructors');
});

test("a recent copy is shown at once for today's link or the same date, never for another day", () => {
  withStorage(() => {
    const now = Date.now();
    writeCachedForm('tok', data('2026-11-24'), now);
    assert.equal(readCachedForm('tok', null, '2026-11-24', now)?.date, '2026-11-24', "today's link");
    assert.equal(readCachedForm('tok', '2026-11-24', '2026-11-24', now)?.date, '2026-11-24');
    assert.equal(readCachedForm('tok', '2026-11-23', '2026-11-24', now), null, 'another date');
    assert.equal(readCachedForm('tok', null, '2026-11-25', now), null, 'the next day');
    assert.equal(readCachedForm('tok', null, '2026-11-24', now + 46 * 60 * 1000), null, 'too old: photo links would have expired');
    assert.equal(readCachedForm('other', null, '2026-11-24', now), null);
    assert.deepEqual(cachedInstitute('tok'), { name: 'Aurora University', location: 'Hyderabad' }, 'the name for the header from any visit');
  });
});

test('a broken copy is ignored', () => {
  withStorage((values) => {
    values.set('ft_form:tok', '{not json');
    assert.equal(readCachedForm('tok', null, '2026-11-24'), null);
    assert.equal(cachedInstitute('tok'), null);
  });
});

test('the form starts loading before the app draws, and public pages skip admin sign-in work', () => {
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.ok(main.indexOf('prefetchPublicForm(formRoute.token, formRoute.date)') < main.indexOf('createRoot('), 'asked for before drawing');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.equal((app.match(/if \(publicForm \|\| publicReport \|\| dailyReport\) return undefined;/g) || []).length, 2, 'no session check and no instructor list on public pages');
  const page = readFileSync(new URL('../src/components/PublicFormPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /takePrefetchedForm\(token, date\)/);
  assert.match(page, /readCachedForm\(token, date, localDateValue\(\)\)/);
  assert.match(page, /aria-label="Opening the form"/, 'the questions show while loading');
  assert.ok(!readFileSync(new URL('../src/components/FormPeopleEditor.tsx', import.meta.url), 'utf8').includes('Names are filled in from the name labels'));
});
