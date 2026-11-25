import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { draftKey, draftMatches, usableDraft } from '../src/lib/formDraftStore.ts';

const draft = (changes = {}) => ({
  version: 1,
  savedAt: Date.now(),
  baseUpdatedAt: null,
  status: 'yes',
  submittedBy: 'Ravi',
  reason: '',
  reasonOther: '',
  keptIds: [],
  added: [],
  people: {},
  ...changes,
});

test('a kept draft belongs to one form link and one date', () => {
  assert.equal(draftKey('abcdefghijklmnopqrstuvwx', '2026-11-24'), 'abcdefghijklmnopqrstuvwx:2026-11-24');
});

test('only a recent draft of this version is brought back', () => {
  assert.ok(usableDraft(draft()));
  assert.equal(usableDraft(draft({ savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })), null, 'older than a week');
  assert.equal(usableDraft(draft({ version: 2 })), null);
  assert.equal(usableDraft(undefined), null);
  assert.equal(usableDraft({ version: 1, savedAt: Date.now() }), null, 'incomplete');
});

test('a draft is used only while the response on the server is as it was', () => {
  assert.ok(draftMatches(draft(), null), 'a new form, still not sent');
  assert.equal(draftMatches(draft(), '2026-11-24T05:00:00.000Z'), false, 'sent from another device meanwhile');
  const editing = draft({ baseUpdatedAt: '2026-11-24T05:00:00.000Z' });
  assert.ok(draftMatches(editing, '2026-11-24T05:00:00.000Z'));
  assert.equal(draftMatches(editing, '2026-11-24T06:00:00.000Z'), false, 'changed elsewhere since editing began');
});

test('the form keeps answers on change and on leaving, brings them back, and forgets them once sent or cleared', () => {
  const page = readFileSync(new URL('../src/components/PublicFormPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /saveFormDraft\(key, toStoredDraft\(draft, base\)\)/);
  assert.match(page, /window\.addEventListener\('pagehide', keepNow\)/);
  assert.match(page, /void restoreKeptDraft\(result, \(\) => disposed\)/);
  assert.match(page, /forgetKeptDraft\(data\.date\);\s*writeCachedForm\(token, \{ \.\.\.data, response: saved \}\);\s*setData\(\{ \.\.\.data, response: saved \}\)/, 'forgotten once sent');
  assert.match(page, /const clearForm = \(\) => \{\s*forgetKeptDraft\(\);/);
  assert.match(page, /const cancelEdit = \(\) => \{\s*forgetKeptDraft\(\);/);
  assert.match(page, /Start over/);
});
