/**
 * Opens the camera, waiting a moment if another screen has only just let go.
 *
 * Switching between the one-person and group screens closes one camera and
 * opens another in the same instant. Stopping a track is immediate in the page,
 * but Android releases the camera hardware a fraction of a second later, and a
 * request that lands inside that gap is refused as though another app held the
 * camera. Nothing was wrong - the screen just asked too early - yet it showed
 * "the camera is already in use" and stayed that way until somebody clicked the
 * tab again. The same gap opens when flipping between the front and back
 * cameras.
 *
 * So a refusal that means "busy" is retried a few times with a growing pause,
 * about three seconds in all, before it is reported. Every other refusal -
 * permission denied, no camera, a constraint the device cannot meet - is
 * reported at once, because waiting cannot change it.
 */

/** The refusals that mean "not yet", rather than "not possible". */
export const CAMERA_BUSY_ERRORS: ReadonlySet<string> = new Set([
  'NotReadableError',
  'AbortError',
  // Older Chrome's name for the same thing.
  'TrackStartError',
]);

/** Pauses before each retry. About three seconds in total. */
export const CAMERA_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 1500];

export interface OpenCameraOptions {
  /** True once the screen that asked has gone, so no retry outlives it. */
  isCancelled?: () => boolean;
  delays?: readonly number[];
  /** Test seams. */
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
