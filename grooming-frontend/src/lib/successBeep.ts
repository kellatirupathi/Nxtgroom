export const BEEP_FREQUENCY_HZ = 1_800;
export const BEEP_DURATION_S = 0.18;
export const BEEP_VOLUME = 0.5;
const ATTACK_S = 0.01;
const RELEASE_S = 0.05;
const SILENT = 0.0001;

interface Ramp {
  setValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
}

interface ToneNode {
  connect(destination: unknown): unknown;
}

export interface BeepContext {
  state: string;
  currentTime: number;
  destination: unknown;
  resume(): Promise<void>;
  createOscillator(): ToneNode & {
    type: string;
    frequency: Ramp;
    start(when: number): void;
    stop(when: number): void;
  };
  createGain(): ToneNode & { gain: Ramp };
}

type ContextFactory = () => BeepContext | null;

function browserContext(): BeepContext | null {
  if (typeof window === 'undefined') return null;
  const Constructor = (window as unknown as {
    AudioContext?: new () => BeepContext;
    webkitAudioContext?: new () => BeepContext;
  }).AudioContext || (window as unknown as { webkitAudioContext?: new () => BeepContext }).webkitAudioContext;
  if (!Constructor) return null;
  try {
    return new Constructor();
  } catch {
    return null;
  }
}

let shared: BeepContext | null = null;
let factory: ContextFactory = browserContext;

export function setBeepContextFactory(next: ContextFactory | null): void {
  factory = next || browserContext;
  shared = null;
}

function context(): BeepContext | null {
  shared ||= factory();
  return shared;
}

export function unlockBeep(): void {
  const audio = context();
  if (audio?.state === 'suspended') audio.resume().catch(() => {});
}

export function armBeepUnlock(target: Pick<Window, 'addEventListener' | 'removeEventListener'> | null =
  typeof window === 'undefined' ? null : window): () => void {
  if (!target) return () => {};
  const events = ['pointerdown', 'touchstart', 'keydown'] as const;
  const unlock = () => {
    unlockBeep();
    for (const name of events) target.removeEventListener(name, unlock);
  };
  for (const name of events) target.addEventListener(name, unlock, { passive: true });
  return () => {
    for (const name of events) target.removeEventListener(name, unlock);
  };
}

export function playSuccessBeep(): void {
  try {
    const audio = context();
    if (!audio) return;
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    const start = audio.currentTime;
    const end = start + BEEP_DURATION_S;
    const tone = audio.createOscillator();
    const level = audio.createGain();
    tone.type = 'sine';
    tone.frequency.setValueAtTime(BEEP_FREQUENCY_HZ, start);
    level.gain.setValueAtTime(SILENT, start);
    level.gain.exponentialRampToValueAtTime(BEEP_VOLUME, start + ATTACK_S);
    level.gain.setValueAtTime(BEEP_VOLUME, end - RELEASE_S);
    level.gain.exponentialRampToValueAtTime(SILENT, end);
    tone.connect(level);
    level.connect(audio.destination);
    tone.start(start);
    tone.stop(end + 0.02);
  } catch {
  }
}

export function beepsFor(action: string | null | undefined, recorded: boolean | null | undefined): boolean {
  return Boolean(recorded) && (action === 'CHECK_IN' || action === 'CHECK_OUT');
}
