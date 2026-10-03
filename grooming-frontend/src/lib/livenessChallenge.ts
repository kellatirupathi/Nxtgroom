import type { FrameReading } from './fullBodyDetector.ts';

export type ChallengeSide = 'left' | 'right';
export type LivenessPhase = 'POSITION' | 'CHALLENGE' | 'LOWER' | 'VERIFIED';

export interface LivenessState {
  phase: LivenessPhase;
  side: ChallengeSide;
  confirmations: number;
  deadline: number | null;
}

export const LIVENESS_CONFIRMATIONS = 3;
export const LIVENESS_CHALLENGE_MS = 10_000;

export function randomChallengeSide(): ChallengeSide {
  try {
    const value = new Uint8Array(1);
    globalThis.crypto.getRandomValues(value);
    return value[0] % 2 === 0 ? 'left' : 'right';
  } catch {
    return Math.random() < 0.5 ? 'left' : 'right';
  }
}

export function createLivenessState(side: ChallengeSide = randomChallengeSide()): LivenessState {
  return { phase: 'POSITION', side, confirmations: 0, deadline: null };
}

function reset(state: LivenessState, flipSide = false): LivenessState {
  return createLivenessState(
    flipSide ? (state.side === 'left' ? 'right' : 'left') : state.side,
  );
}

function confirmed(state: LivenessState, matches: boolean): number {
  return matches ? state.confirmations + 1 : 0;
}

export function advanceLiveness(
  state: LivenessState,
  reading: FrameReading,
  now = Date.now(),
): LivenessState {
  if (
    reading.verdict === 'NO_PERSON'
    || reading.verdict === 'MULTIPLE_PEOPLE'
    || reading.verdict === 'UNAVAILABLE'
    || !reading.poseSignals
  ) {
    return state.phase === 'POSITION' ? { ...state, confirmations: 0 } : reset(state);
  }

  const { leftWrist, rightWrist } = reading.poseSignals;
  const bothLowered = leftWrist === 'LOWERED' && rightWrist === 'LOWERED';

  if (state.phase === 'VERIFIED') return state;

  if (state.phase === 'POSITION') {
    const confirmations = confirmed(state, bothLowered);
    if (confirmations < LIVENESS_CONFIRMATIONS) return { ...state, confirmations };
    return {
      ...state,
      phase: 'CHALLENGE',
      confirmations: 0,
      deadline: now + LIVENESS_CHALLENGE_MS,
    };
  }

  if (state.deadline != null && now > state.deadline) {
    return reset(state, true);
  }

  if (state.phase === 'CHALLENGE') {
    const target = state.side === 'left' ? leftWrist : rightWrist;
    const other = state.side === 'left' ? rightWrist : leftWrist;
    const confirmations = confirmed(
      state,
      target === 'RAISED' && other !== 'RAISED',
    );
    if (confirmations < LIVENESS_CONFIRMATIONS) return { ...state, confirmations };
    return { ...state, phase: 'LOWER', confirmations: 0 };
  }

  const confirmations = confirmed(state, bothLowered);
  if (confirmations < LIVENESS_CONFIRMATIONS) return { ...state, confirmations };
  return { ...state, phase: 'VERIFIED', confirmations: 0, deadline: null };
}

export function livenessInstruction(state: LivenessState): string {
  switch (state.phase) {
    case 'POSITION':
      return 'Live check: stand still with both arms down';
    case 'CHALLENGE':
      return `Live check: raise your ${state.side} hand`;
    case 'LOWER':
      return 'Live check: lower your hand';
    case 'VERIFIED':
      return 'Live person verified';
  }
}

export function livenessVerified(state: LivenessState): boolean {
  return state.phase === 'VERIFIED';
}
