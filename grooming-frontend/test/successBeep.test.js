import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  armBeepUnlock,
  BEEP_DURATION_S,
  BEEP_FREQUENCY_HZ,
  beepsFor,
  playSuccessBeep,
  preloadThankYou,
  setBeepContextFactory,
  setClipLoader,
  THANK_YOU_CLIP_URL,
  unlockBeep,
} from '../src/lib/successBeep.ts';

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

function fakeContext(state = 'running') {
  const log = [];
  const ramp = (name) => ({
    setValueAtTime: (value, time) => log.push([`${name}.set`, value, Number(time.toFixed(3))]),
    exponentialRampToValueAtTime: (value, time) => log.push([`${name}.ramp`, value, Number(time.toFixed(3))]),
  });
  const context = {
    state,
    currentTime: 10,
    destination: 'speaker',
    resumed: 0,
    resume: async () => { context.resumed += 1; context.state = 'running'; },
    createOscillator: () => ({
      frequency: ramp('frequency'),
      connect: (target) => log.push(['connect', 'oscillator', target === 'speaker' ? 'speaker' : 'gain']),
      start: (when) => log.push(['start', when]),
      stop: (when) => log.push(['stop', Number(when.toFixed(3))]),
      set type(value) { log.push(['type', value]); },
    }),
    createGain: () => ({
      gain: ramp('gain'),
      connect: (target) => log.push(['connect', 'gain', target]),
    }),
  };
  return { context, log };
}

test('one short sine beep, faded in and out, under a fifth of a second', () => {
  const { context, log } = fakeContext();
  setBeepContextFactory(() => context);
  try {
    playSuccessBeep();
    assert.ok(BEEP_DURATION_S <= 0.2, 'short enough not to hold anybody up');
    assert.deepEqual(log.find((entry) => entry[0] === 'type'), ['type', 'sine']);
    assert.deepEqual(log.find((entry) => entry[0] === 'frequency.set'), ['frequency.set', BEEP_FREQUENCY_HZ, 10]);
    const gain = log.filter((entry) => entry[0].startsWith('gain.'));
    assert.equal(gain[0][1] < 0.001, true, 'starts silent: no click');
    assert.equal(gain.at(-1)[1] < 0.001, true, 'ends silent: no click');
    assert.equal(gain.at(-1)[2], 10.18);
    assert.deepEqual(log.find((entry) => entry[0] === 'start'), ['start', 10]);
    assert.deepEqual(log.find((entry) => entry[0] === 'connect' && entry[1] === 'gain'), ['connect', 'gain', 'speaker']);
  } finally {
    setBeepContextFactory(null);
  }
});

test('a suspended context is woken by the first tap, and no audio is never an error', async () => {
  const { context } = fakeContext('suspended');
  setBeepContextFactory(() => context);
  const listeners = new Map();
  const target = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
  };
  try {
    const cleanup = armBeepUnlock(target);
    assert.deepEqual([...listeners.keys()].sort(), ['keydown', 'pointerdown', 'touchstart']);
    listeners.get('pointerdown')();
    await Promise.resolve();
    assert.equal(context.resumed, 1);
    assert.equal(listeners.size, 0, 'one tap is enough: the listeners go');
    cleanup();
    unlockBeep();
    assert.equal(context.resumed, 1, 'already running');
  } finally {
    setBeepContextFactory(null);
  }

  setBeepContextFactory(() => null);
  try {
    assert.doesNotThrow(() => playSuccessBeep());
  } finally {
    setBeepContextFactory(null);
  }
  setBeepContextFactory(() => { throw new Error('no audio device'); });
  try {
    assert.doesNotThrow(() => playSuccessBeep());
  } finally {
    setBeepContextFactory(null);
  }
});

test('a recorded attendance says "Thank you" once the clip has loaded', async () => {
  const { context, log } = fakeContext();
  const decoded = { duration: 0.68 };
  const requested = [];
  context.decodeAudioData = async (bytes) => {
    log.push(['decode', bytes.byteLength]);
    return decoded;
  };
  context.createBufferSource = () => {
    const source = {
      buffer: null,
      connect: (target) => log.push(['connect', 'clip', target === 'speaker' ? 'speaker' : 'gain']),
      start: (when) => log.push(['clip.start', when, source.buffer === decoded]),
    };
    return source;
  };
  setBeepContextFactory(() => context);
  setClipLoader(async (url) => { requested.push(url); return new ArrayBuffer(16); });
  try {
    await preloadThankYou();
    assert.deepEqual(requested, [THANK_YOU_CLIP_URL]);
    playSuccessBeep();
    assert.deepEqual(log.find((entry) => entry[0] === 'clip.start'), ['clip.start', 10, true], 'the decoded clip plays now');
    assert.equal(log.some((entry) => entry[0] === 'type'), false, 'no beep tone when the voice plays');
    assert.deepEqual(log.find((entry) => entry[0] === 'connect' && entry[1] === 'gain'), ['connect', 'gain', 'speaker']);
    await preloadThankYou();
    assert.equal(requested.length, 1, 'the clip is fetched once and reused');
  } finally {
    setClipLoader(null);
    setBeepContextFactory(null);
  }
});

test('the beep still plays when the clip is missing or not loaded yet', async () => {
  const { context, log } = fakeContext();
  context.decodeAudioData = async () => { throw new Error('cannot decode'); };
  context.createBufferSource = () => { throw new Error('must not play a clip'); };
  setBeepContextFactory(() => context);
  setClipLoader(async () => { throw new Error('offline'); });
  try {
    await preloadThankYou();
    assert.doesNotThrow(() => playSuccessBeep());
    assert.deepEqual(log.find((entry) => entry[0] === 'type'), ['type', 'sine'], 'falls back to the beep');
  } finally {
    setClipLoader(null);
    setBeepContextFactory(null);
  }
});

test('the clip ships with the site and is served as a file, not the app page', () => {
  const clip = readFileSync(new URL('../public/sounds/thank-you.wav', import.meta.url));
  assert.equal(clip.toString('ascii', 0, 4), 'RIFF');
  assert.equal(clip.toString('ascii', 8, 12), 'WAVE');
  assert.ok(clip.length < 200_000, 'small enough to load instantly');
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const spa = new RegExp(`^${config.rewrites[0].source}$`);
  assert.equal(spa.test(THANK_YOU_CLIP_URL), false, 'not rewritten to index.html');
  assert.ok(config.headers.some((rule) => rule.source === '/sounds/(.*)'), 'a cache rule for /sounds');
});

test('only a recorded check-in or check-out beeps', () => {
  assert.equal(beepsFor('CHECK_IN', true), true);
  assert.equal(beepsFor('CHECK_OUT', true), true);
  assert.equal(beepsFor('CHECK_IN', false), false);
  for (const action of ['TOO_EARLY', 'ALREADY_DONE', 'NOT_RECOGNISED']) {
    assert.equal(beepsFor(action, true), false, action);
  }
  assert.equal(beepsFor(undefined, true), false);
});

test('every place that records attendance beeps once it is recorded', () => {
  const single = source('components/KioskAttendance.tsx');
  assert.match(single, /if \(!next\.duplicate && beepsFor\(next\.action, next\.recorded\)\) playSuccessBeep\(\);/);
  const group = source('components/GroupKioskAttendance.tsx');
  assert.match(group, /if \(!next\.duplicate && next\.people\.some\(\(person\) => beepsFor\(person\.action, person\.recorded\)\)\) playSuccessBeep\(\);/);
  const form = source('components/EvaluateCard.tsx');
  assert.equal((form.match(/playSuccessBeep\(\);/g) || []).length, 2, 'check-in and check-out');
  for (const file of ['components/AttendanceScreen.tsx', 'components/EvaluateCard.tsx']) {
    assert.match(source(file), /useEffect\(\(\) => armBeepUnlock\(\), \[\]\);/, file);
  }
});
