import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceLiveness,
  createLivenessState,
  LIVENESS_CHALLENGE_MS,
  livenessInstruction,
  livenessVerified,
} from '../src/lib/livenessChallenge.ts';

const frame = (leftWrist, rightWrist, verdict = 'FULL_BODY') => ({
  verdict,
  guidance: null,
  poseSignals: { leftWrist, rightWrist },
});

function repeat(state, reading, count, now = 1_000) {
  let current = state;
  for (let index = 0; index < count; index += 1) {
    current = advanceLiveness(current, reading, now + index * 200);
  }
  return current;
}

test('a static photograph with both hands down cannot complete the live challenge', () => {
  let state = repeat(createLivenessState('left'), frame('LOWERED', 'LOWERED'), 3);
  assert.equal(state.phase, 'CHALLENGE');
  state = repeat(state, frame('LOWERED', 'LOWERED'), 20, 2_000);
  assert.equal(livenessVerified(state), false);
  assert.match(livenessInstruction(state), /raise your left hand/i);
});

test('a random hand raise followed by lowering verifies a live person', () => {
  let state = repeat(createLivenessState('right'), frame('LOWERED', 'LOWERED'), 3);
  state = repeat(state, frame('LOWERED', 'RAISED'), 2, 2_000);
  assert.equal(state.phase, 'CHALLENGE', 'one noisy frame cannot complete the action');
  state = repeat(state, frame('LOWERED', 'RAISED'), 1, 2_400);
  assert.equal(state.phase, 'LOWER');
  state = repeat(state, frame('LOWERED', 'LOWERED'), 3, 2_600);
  assert.equal(state.phase, 'VERIFIED');
  assert.equal(livenessVerified(state), true);
});

test('moving the wrong hand does not satisfy the challenge', () => {
  let state = repeat(createLivenessState('left'), frame('LOWERED', 'LOWERED'), 3);
  state = repeat(state, frame('LOWERED', 'RAISED'), 10, 2_000);
  assert.equal(state.phase, 'CHALLENGE');
});

test('leaving the frame resets an unfinished challenge', () => {
  let state = repeat(createLivenessState('left'), frame('LOWERED', 'LOWERED'), 3);
  state = advanceLiveness(state, frame('UNKNOWN', 'UNKNOWN', 'NO_PERSON'), 2_000);
  assert.equal(state.phase, 'POSITION');
  assert.equal(state.confirmations, 0);
});

test('an expired challenge resets and changes the requested side', () => {
  let state = repeat(createLivenessState('left'), frame('LOWERED', 'LOWERED'), 3, 1_000);
  state = advanceLiveness(
    state,
    frame('LOWERED', 'LOWERED'),
    1_400 + LIVENESS_CHALLENGE_MS + 1,
  );
  assert.equal(state.phase, 'POSITION');
  assert.equal(state.side, 'right');
});

test('verification is revoked when the verified person leaves the frame', () => {
  let state = repeat(createLivenessState('left'), frame('LOWERED', 'LOWERED'), 3);
  state = repeat(state, frame('RAISED', 'LOWERED'), 3, 2_000);
  state = repeat(state, frame('LOWERED', 'LOWERED'), 3, 2_600);
  assert.equal(state.phase, 'VERIFIED');
  state = advanceLiveness(state, frame('UNKNOWN', 'UNKNOWN', 'MULTIPLE_PEOPLE'), 3_500);
  assert.equal(state.phase, 'POSITION');
});
