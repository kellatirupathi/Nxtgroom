/**
 * Decides whether a live camera frame shows a whole person, head to feet.
 *
 * The test is the question itself rather than a proxy for it: a head keypoint
 * and both ankle keypoints, each above a confidence threshold. Face detection
 * cannot see feet, and how much of the frame a person fills says nothing about
 * whether their shoes are in it.
 *
 * Everything here fails open. A device without WebGL, a model that will not
 * download, a frame the detector chokes on — none of those may stop somebody
 * checking in, so each returns "cannot tell" and the caller lets the photo be
 * taken. Blocking attendance is a worse outcome than an unframed photograph.
 */

export type FrameVerdict = 'FULL_BODY' | 'PARTIAL' | 'NO_PERSON' | 'UNAVAILABLE';

export interface FrameReading {
  verdict: FrameVerdict;
  /** What to tell the person in front of the camera, or null when nothing is wrong. */
  guidance: string | null;
}

/** Below this a keypoint is a guess, not a sighting. */
const KEYPOINT_CONFIDENCE = 0.35;
/** MoveNet's ankle and head keypoints, by the names the model returns. */
const HEAD_KEYPOINTS = ['nose', 'left_eye', 'right_eye'];
const ANKLE_KEYPOINTS = ['left_ankle', 'right_ankle'];

type Detector = {
  estimatePoses: (input: HTMLVideoElement) => Promise<Array<{
    keypoints: Array<{ name?: string; score?: number }>;
  }>>;
  dispose?: () => void;
};

let detectorPromise: Promise<Detector | null> | null = null;

/**
 * Loads MoveNet once per page.
 *
 * Imported lazily so the weights and the runtime are fetched when a camera is
 * actually opened, rather than by everybody who loads the app.
 */
export function loadFullBodyDetector(): Promise<Detector | null> {
  detectorPromise ||= (async () => {
    try {
      const [poseDetection] = await Promise.all([
        import('@tensorflow-models/pose-detection'),
        import('@tensorflow/tfjs-backend-webgl'),
      ]);
      const tf = await import('@tensorflow/tfjs-core');
      await tf.setBackend('webgl');
      await tf.ready();
      return await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING },
      ) as unknown as Detector;
    } catch {
      // No WebGL, blocked download, unsupported device. The camera still works.
      return null;
    }
  })();
  return detectorPromise;
}

/** Turns one set of keypoints into a verdict and, when needed, an instruction. */
export function readKeypoints(
  keypoints: Array<{ name?: string; score?: number }> | undefined,
): FrameReading {
  if (!keypoints?.length) {
    return { verdict: 'NO_PERSON', guidance: 'Step into the frame' };
  }
  const seen = (names: string[]) => names.some((name) => keypoints.some(
    (point) => point.name === name && (point.score ?? 0) >= KEYPOINT_CONFIDENCE,
  ));

  const headVisible = seen(HEAD_KEYPOINTS);
  // Both ankles, not either: one foot in frame is not a full-body photograph.
  const anklesVisible = ANKLE_KEYPOINTS.every((name) => seen([name]));

  if (!headVisible && !anklesVisible) {
    return { verdict: 'NO_PERSON', guidance: 'Step into the frame' };
  }
  if (headVisible && anklesVisible) {
    return { verdict: 'FULL_BODY', guidance: null };
  }
  return {
    verdict: 'PARTIAL',
    guidance: anklesVisible
      ? 'Move the camera down — your head is out of frame'
      : 'Step back — your feet are not in frame',
  };
}

/**
 * Reads one frame. Never throws: a detector that fails mid-session reports
 * UNAVAILABLE, which the caller treats as permission to capture.
 */
export async function readFrame(
  detector: Detector | null,
  video: HTMLVideoElement,
): Promise<FrameReading> {
  if (!detector || !video.videoWidth) {
    return { verdict: 'UNAVAILABLE', guidance: null };
  }
  try {
    const poses = await detector.estimatePoses(video);
    return readKeypoints(poses?.[0]?.keypoints);
  } catch {
    return { verdict: 'UNAVAILABLE', guidance: null };
  }
}

/** How long a full body must hold before the shutter unlocks. */
export const STEADY_MS = 1000;
/** How long somebody may be blocked before they can capture regardless. */
export const OVERRIDE_AFTER_MS = 15_000;

/**
 * Whether the shutter should be enabled.
 *
 * Open when a full body has held steady, when the detector is unavailable, and
 * once the override has been offered and taken. A person who cannot satisfy the
 * check — a saree hiding the ankles, a wheelchair, poor light — must still be
 * able to check in.
 */
export function shutterEnabled(
  verdict: FrameVerdict,
  steadyForMs: number,
  overridden: boolean,
): boolean {
  if (overridden || verdict === 'UNAVAILABLE') return true;
  return verdict === 'FULL_BODY' && steadyForMs >= STEADY_MS;
}
