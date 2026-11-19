export const CAMERA_BUSY_ERRORS: ReadonlySet<string> = new Set([
  'NotReadableError',
  'AbortError',
  'TrackStartError',
]);

export const CAMERA_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 1500];

export function cameraVideoConstraints(facing: 'user' | 'environment'): MediaTrackConstraints {
  return {
    facingMode: { ideal: facing },
    width: { ideal: 2560 },
    height: { ideal: 1440 },
    frameRate: { ideal: 30 },
  };
}

const CONTINUOUS_MODES = ['focusMode', 'exposureMode', 'whiteBalanceMode'] as const;

export const MAX_VIDEO_LONG_SIDE = 3840;

export const VIDEO_SIZES: readonly (readonly [number, number])[] = [
  [3840, 2160],
  [2560, 1920],
  [2560, 1440],
  [1920, 1440],
  [1920, 1080],
  [1280, 960],
];

type TunableTrack = {
  getCapabilities?: () => object;
  getSettings?: () => MediaTrackSettings;
  applyConstraints?: (constraints: MediaTrackConstraints) => Promise<void>;
};

function maxOf(range: unknown): number {
  const max = (range as { max?: unknown } | undefined)?.max;
  return typeof max === 'number' && Number.isFinite(max) ? max : 0;
}

function currentSize(track: TunableTrack): { width: number; height: number } {
  try {
    const settings = track.getSettings?.();
    return { width: Number(settings?.width) || 0, height: Number(settings?.height) || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

export function videoSizeCandidates(
  capabilities: Record<string, unknown>,
  current: { width: number; height: number },
): { width: number; height: number }[] {
  const capWidth = maxOf(capabilities.width);
  const capHeight = maxOf(capabilities.height);
  if (!capWidth || !capHeight) return [];
  const portrait = current.height > current.width;
  const currentLong = Math.max(current.width, current.height);
  return VIDEO_SIZES
    .filter(([long]) => long <= MAX_VIDEO_LONG_SIDE && long > currentLong)
    .map(([long, short]) => (portrait ? { width: short, height: long } : { width: long, height: short }))
    .filter(({ width, height }) => {
      const fitsAsIs = width <= capWidth && height <= capHeight;
      const fitsTurned = height <= capWidth && width <= capHeight;
      return fitsAsIs || fitsTurned;
    });
}

export async function raiseCameraResolution(track: TunableTrack | null | undefined): Promise<{ width: number; height: number } | null> {
  if (!track || typeof track.getCapabilities !== 'function' || typeof track.applyConstraints !== 'function') return null;
  let capabilities: Record<string, unknown>;
  try {
    capabilities = track.getCapabilities() as Record<string, unknown>;
  } catch {
    return null;
  }
  const before = currentSize(track);
  for (const size of videoSizeCandidates(capabilities, before)) {
    try {
      await track.applyConstraints({ width: { exact: size.width }, height: { exact: size.height } });
      const after = currentSize(track);
      if (Math.max(after.width, after.height) > Math.max(before.width, before.height)) return after;
    } catch {
    }
  }
  return null;
}

export async function tuneCameraTrack(track: TunableTrack | null | undefined): Promise<void> {
  if (!track || typeof track.getCapabilities !== 'function' || typeof track.applyConstraints !== 'function') return;
  await raiseCameraResolution(track).catch(() => null);
  let capabilities: Record<string, unknown>;
  try {
    capabilities = track.getCapabilities() as Record<string, unknown>;
  } catch {
    return;
  }
  const advanced = CONTINUOUS_MODES
    .filter((mode) => Array.isArray(capabilities[mode]) && (capabilities[mode] as unknown[]).includes('continuous'))
    .map((mode) => ({ [mode]: 'continuous' }));
  if (!advanced.length) return;
  await track.applyConstraints({ advanced } as MediaTrackConstraints).catch(() => {});
}

// Switching between the one-person and group screens closes one camera and
// opens another. Stopping and restarting the camera takes a second or more
// on a tablet (an iPad especially, and longer still if it reports the camera
// as busy), so the closing screen parks its live stream for a moment and the
// opening screen picks it up at once. A parked stream nobody claims is
// stopped shortly after, so the camera light does not stay on.
export const CAMERA_HANDOVER_MS = 2_500;

type StreamLike = Pick<MediaStream, 'getTracks' | 'getVideoTracks'>;

let parked: { stream: StreamLike; facing: string; timer: ReturnType<typeof setTimeout> } | null = null;

function stopStream(stream: StreamLike): void {
  stream.getTracks().forEach((track) => track.stop());
}

function isLive(stream: StreamLike): boolean {
  const tracks = stream.getVideoTracks();
  return tracks.length > 0 && tracks.every((track) => track.readyState === 'live');
}

export function parkCameraStream(stream: StreamLike, facing: string, holdMs = CAMERA_HANDOVER_MS): void {
  if (parked && parked.stream !== stream) {
    clearTimeout(parked.timer);
    stopStream(parked.stream);
    parked = null;
  }
  if (!isLive(stream)) {
    stopStream(stream);
    return;
  }
  if (parked) clearTimeout(parked.timer);
  const timer = setTimeout(() => {
    if (parked?.stream === stream) {
      parked = null;
      stopStream(stream);
    }
  }, holdMs);
  parked = { stream, facing, timer };
}

export function takeParkedCameraStream<T extends StreamLike = MediaStream>(facing: string): T | null {
  if (!parked) return null;
  const { stream, facing: parkedFacing, timer } = parked;
  clearTimeout(timer);
  parked = null;
  if (parkedFacing !== facing || !isLive(stream)) {
    stopStream(stream);
    return null;
  }
  return stream as T;
}

export function stopParkedCameraStream(): void {
  if (!parked) return;
  clearTimeout(parked.timer);
  stopStream(parked.stream);
  parked = null;
}

export interface OpenCameraOptions {
  isCancelled?: () => boolean;
  delays?: readonly number[];
  wait?: (milliseconds: number) => Promise<void>;
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
}

export async function openCameraStream(
  constraints: MediaStreamConstraints,
  {
    isCancelled = () => false,
    delays = CAMERA_RETRY_DELAYS_MS,
    wait = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }),
    mediaDevices,
  }: OpenCameraOptions = {},
): Promise<MediaStream> {
  const devices = mediaDevices ?? navigator.mediaDevices;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await devices.getUserMedia(constraints);
    } catch (error) {
      const name = (error as { name?: string })?.name || '';
      if (!CAMERA_BUSY_ERRORS.has(name) || attempt >= delays.length || isCancelled()) throw error;
      await wait(delays[attempt]);
      if (isCancelled()) throw error;
    }
  }
}
