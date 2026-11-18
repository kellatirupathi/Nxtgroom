export const BEEP_FREQUENCY_HZ = 1_800;
export const BEEP_DURATION_S = 0.18;
export const BEEP_VOLUME = 0.5;
export const THANK_YOU_CLIP_URL = '/sounds/thank-you.wav';
export const THANK_YOU_VOLUME = 1;
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
  decodeAudioData?(data: ArrayBuffer): Promise<unknown>;
  createBufferSource?(): ToneNode & {
    buffer: unknown;
    start(when?: number): void;
  };
}

type ContextFactory = () => BeepContext | null;
type ClipLoader = (url: string) => Promise<ArrayBuffer>;

async function fetchClip(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`The thank-you clip could not be loaded (${response.status})`);
  return response.arrayBuffer();
}

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
let loadClip: ClipLoader = fetchClip;
let clip: unknown = null;
let clipLoading: Promise<void> | null = null;

export function setBeepContextFactory(next: ContextFactory | null): void {
  factory = next || browserContext;
  shared = null;
  clip = null;
  clipLoading = null;
}

export function setClipLoader(next: ClipLoader | null): void {
  loadClip = next || fetchClip;
  clip = null;
  clipLoading = null;
}

function context(): BeepContext | null {
  shared ||= factory();
  return shared;
}

export function preloadThankYou(): Promise<void> {
  if (clip) return Promise.resolve();
  if (clipLoading) return clipLoading;
  let audio: BeepContext | null;
  try {
    audio = context();
  } catch {
    return Promise.resolve();
  }
  if (!audio?.decodeAudioData || !audio.createBufferSource) return Promise.resolve();
  const decoder = audio;
  clipLoading = loadClip(THANK_YOU_CLIP_URL)
    .then((bytes) => decoder.decodeAudioData?.(bytes))
    .then((decoded) => {
      if (decoded) clip = decoded;
    })
    .catch(() => {})
    .finally(() => {
      clipLoading = null;
    });
  return clipLoading;
}

export function unlockBeep(): void {
  const audio = context();
  if (audio?.state === 'suspended') audio.resume().catch(() => {});
}

export function armBeepUnlock(target: Pick<Window, 'addEventListener' | 'removeEventListener'> | null =
  typeof window === 'undefined' ? null : window): () => void {
  if (!target) return () => {};
  void preloadThankYou();
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

function playThankYou(audio: BeepContext): boolean {
  if (!clip || !audio.createBufferSource) return false;
  const source = audio.createBufferSource();
  const level = audio.createGain();
  source.buffer = clip;
  level.gain.setValueAtTime(THANK_YOU_VOLUME, audio.currentTime);
  source.connect(level);
  level.connect(audio.destination);
  source.start(audio.currentTime);
  return true;
}

export function playSuccessBeep(): void {
  try {
    const audio = context();
    if (!audio) return;
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    if (playThankYou(audio)) return;
    void preloadThankYou();
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
