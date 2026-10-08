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

type TunableTrack = {
  getCapabilities?: () => object;
  applyConstraints?: (constraints: MediaTrackConstraints) => Promise<void>;
};

export async function tuneCameraTrack(track: TunableTrack | null | undefined): Promise<void> {
  if (!track || typeof track.getCapabilities !== 'function' || typeof track.applyConstraints !== 'function') return;
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
