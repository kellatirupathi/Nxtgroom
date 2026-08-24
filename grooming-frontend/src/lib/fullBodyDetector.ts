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

export type FrameVerdict =
  | 'FULL_BODY'
  | 'TOO_FAR'
  | 'PARTIAL'
  | 'NO_PERSON'
  | 'MULTIPLE_PEOPLE'
  | 'UNAVAILABLE';

export interface FrameReading {
  verdict: FrameVerdict;
  /** What to tell the person in front of the camera, or null when nothing is wrong. */
  guidance: string | null;
}

/** Below this a keypoint is a guess, not a sighting. */
const KEYPOINT_CONFIDENCE = 0.35;

import { coverSourceRect } from './cameraGeometry.ts';

/**
 * Nose-to-ankle distance is slightly shorter than the person's true height.
 * At 72% of the image it corresponds to a roughly 80-90% tall person while
 * retaining a safe margin above the hair and below the shoes.
 */
export const MIN_BODY_SPAN_RATIO = 0.72;
/** MoveNet's ankle and head keypoints, by the names the model returns. */
const HEAD_KEYPOINTS = ['nose', 'left_eye', 'right_eye'];
const ANKLE_KEYPOINTS = ['left_ankle', 'right_ankle'];

type Keypoint = { name?: string; score?: number; x?: number; y?: number };
type Pose = { keypoints: Keypoint[]; score?: number };

type Detector = {
  estimatePoses: (
    input: HTMLVideoElement | HTMLCanvasElement,
    config?: { maxPoses?: number },
  ) => Promise<Pose[]>;
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
        {
          modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
          enableTracking: true,
          multiPoseMaxDimension: 320,
          minPoseScore: 0.15,
        },
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
  keypoints: Keypoint[] | undefined,
  frameHeight?: number,
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
    const visibleHead = keypoints.filter((point) => (
      point.name != null
      && HEAD_KEYPOINTS.includes(point.name)
      && (point.score ?? 0) >= KEYPOINT_CONFIDENCE
      && Number.isFinite(point.y)
    ));
    const visibleAnkles = keypoints.filter((point) => (
      point.name != null
      && ANKLE_KEYPOINTS.includes(point.name)
      && (point.score ?? 0) >= KEYPOINT_CONFIDENCE
      && Number.isFinite(point.y)
    ));
    if (frameHeight && visibleHead.length && visibleAnkles.length) {
      const headY = Math.min(...visibleHead.map((point) => point.y as number));
      const ankleY = Math.max(...visibleAnkles.map((point) => point.y as number));
      if ((ankleY - headY) / frameHeight < MIN_BODY_SPAN_RATIO) {
        return {
          verdict: 'TOO_FAR',
          guidance: 'Move closer - fill the guide from head to feet',
        };
      }
    }
    return { verdict: 'FULL_BODY', guidance: null };
  }
  return {
    verdict: 'PARTIAL',
    guidance: anklesVisible
      ? 'Move the camera down — your head is out of frame'
      : 'Step back — your feet are not in frame',
  };
}

/** A partial face or body is enough evidence that another person is present. */
function isDetectedPerson(pose: Pose): boolean {
  const confident = pose.keypoints.filter((point) => (
    (point.score ?? 0) >= KEYPOINT_CONFIDENCE
  ));
  const visibleHeadPoints = confident.filter((point) => (
    point.name != null && HEAD_KEYPOINTS.includes(point.name)
  )).length;
  return visibleHeadPoints >= 2 || confident.length >= 4;
}

/** Converts all poses in a frame into one capture decision. */
export function readPoses(
  poses: Pose[] | undefined,
  frameHeight?: number,
): FrameReading {
  const people = (poses || []).filter(isDetectedPerson);
  if (people.length > 1) {
    return {
      verdict: 'MULTIPLE_PEOPLE',
      guidance: 'Only one person should be visible',
    };
  }
  return readKeypoints(people[0]?.keypoints, frameHeight);
}

/**
 * Reads one frame. Never throws: a detector that fails mid-session reports
 * UNAVAILABLE, which the caller treats as permission to capture.
 */
export async function readFrame(
  detector: Detector | null,
  video: HTMLVideoElement,
  viewport?: { width: number; height: number; canvas: HTMLCanvasElement },
): Promise<FrameReading> {
  if (!detector || !video.videoWidth) {
    return { verdict: 'UNAVAILABLE', guidance: null };
  }
  try {
    let input: HTMLVideoElement | HTMLCanvasElement = video;
    let frameHeight = video.videoHeight;
    if (viewport?.width && viewport.height) {
      const crop = coverSourceRect(
        video.videoWidth,
        video.videoHeight,
        viewport.width,
        viewport.height,
      );
      const scale = Math.min(1, 480 / Math.max(crop.width, crop.height));
      const canvas = viewport.canvas;
      canvas.width = Math.max(1, Math.round(crop.width * scale));
      canvas.height = Math.max(1, Math.round(crop.height * scale));
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(
          video,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        input = canvas;
        frameHeight = canvas.height;
      }
    }
    const poses = await detector.estimatePoses(input, { maxPoses: 6 });
    return readPoses(poses, frameHeight);
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
  // An override exists for accessibility and difficult rooms, never to permit
  // another person's face or body in attendance evidence.
  if (verdict === 'MULTIPLE_PEOPLE') return false;
  if (overridden || verdict === 'UNAVAILABLE') return true;
  return verdict === 'FULL_BODY' && steadyForMs >= STEADY_MS;
}
