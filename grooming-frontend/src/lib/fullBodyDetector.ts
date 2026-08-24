/**
 * Decides whether a live camera frame shows a whole person, head to feet.
 *
 * The test is the question itself rather than a proxy for it: a head keypoint
 * and both ankle keypoints, each above a confidence threshold. Face detection
 * cannot see feet, and how much of the frame a person fills says nothing about
 * whether their shoes are in it.
 *
 * Detector infrastructure failures fail open so unsupported hardware cannot
 * prevent attendance. A successful detector reading still requires one person
 * and never permits an empty frame or multiple people.
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

export interface StableFrameState {
  reading: FrameReading;
  candidate: FrameReading | null;
  candidateCount: number;
}

/**
 * A credible partial face or body is evidence that another person is present.
 *
 * MoveNet sometimes emits a second, weak pose made from four points belonging
 * to the main person. Treating that guess as a second person made an otherwise
 * empty frame flash "multiple people" on tablets. A partial face remains
 * sufficient, while a body-only detection needs several coherent landmarks.
 */
function isDetectedPerson(pose: Pose): boolean {
  const confident = pose.keypoints.filter((point) => (
    (point.score ?? 0) >= KEYPOINT_CONFIDENCE
  ));
  const visibleHeadPoints = confident.filter((point) => (
    point.name != null && HEAD_KEYPOINTS.includes(point.name)
  )).length;
  const namedBodyPoints = confident.filter((point) => (
    point.name != null
    && !HEAD_KEYPOINTS.includes(point.name)
  )).length;
  return visibleHeadPoints >= 2
    || (visibleHeadPoints >= 1 && namedBodyPoints >= 4)
    || namedBodyPoints >= 7;
}

type PoseBounds = { left: number; top: number; right: number; bottom: number };

function poseBounds(pose: Pose): PoseBounds | null {
  const points = pose.keypoints.filter((point) => (
    (point.score ?? 0) >= KEYPOINT_CONFIDENCE
    && Number.isFinite(point.x)
    && Number.isFinite(point.y)
  ));
  if (!points.length) return null;
  return {
    left: Math.min(...points.map((point) => point.x as number)),
    top: Math.min(...points.map((point) => point.y as number)),
    right: Math.max(...points.map((point) => point.x as number)),
    bottom: Math.max(...points.map((point) => point.y as number)),
  };
}

/** True when two model outputs are overlapping copies of the same person. */
function duplicatePose(first: Pose, second: Pose, frameHeight?: number): boolean {
  const a = poseBounds(first);
  const b = poseBounds(second);
  if (!a || !b) return false;
  const intersectionWidth = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const intersectionHeight = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const intersection = intersectionWidth * intersectionHeight;
  const aArea = Math.max(1, (a.right - a.left) * (a.bottom - a.top));
  const bArea = Math.max(1, (b.right - b.left) * (b.bottom - b.top));
  if (intersection / Math.min(aArea, bArea) >= 0.72) return true;

  const aHead = first.keypoints.find((point) => (
    point.name === 'nose' && (point.score ?? 0) >= KEYPOINT_CONFIDENCE
  ));
  const bHead = second.keypoints.find((point) => (
    point.name === 'nose' && (point.score ?? 0) >= KEYPOINT_CONFIDENCE
  ));
  if (!aHead || !bHead || !Number.isFinite(aHead.x) || !Number.isFinite(aHead.y)
      || !Number.isFinite(bHead.x) || !Number.isFinite(bHead.y)) return false;
  const distance = Math.hypot(
    (aHead.x as number) - (bHead.x as number),
    (aHead.y as number) - (bHead.y as number),
  );
  return distance <= Math.max(20, (frameHeight || 0) * 0.055);
}

/** Converts all poses in a frame into one capture decision. */
export function readPoses(
  poses: Pose[] | undefined,
  frameHeight?: number,
): FrameReading {
  const people: Pose[] = [];
  const candidates = (poses || [])
    .filter(isDetectedPerson)
    .sort((a, b) => (
      b.keypoints.filter((point) => (point.score ?? 0) >= KEYPOINT_CONFIDENCE).length
      - a.keypoints.filter((point) => (point.score ?? 0) >= KEYPOINT_CONFIDENCE).length
    ));
  for (const candidate of candidates) {
    if (!people.some((person) => duplicatePose(person, candidate, frameHeight))) {
      people.push(candidate);
    }
  }
  if (people.length > 1) {
    return {
      verdict: 'MULTIPLE_PEOPLE',
      guidance: 'Only one person should be visible',
    };
  }
  return readKeypoints(people[0]?.keypoints, frameHeight);
}

/**
 * Requires the same result across several analyses before changing the UI.
 * One noisy frame must not make the outline or guidance flash.
 */
export function stabilizeFrameReading(
  state: StableFrameState,
  next: FrameReading,
  confirmations = 3,
): StableFrameState {
  if (next.verdict === state.reading.verdict) {
    return { reading: next, candidate: null, candidateCount: 0 };
  }
  const candidateCount = state.candidate?.verdict === next.verdict
    ? state.candidateCount + 1
    : 1;
  if (candidateCount >= confirmations) {
    return { reading: next, candidate: null, candidateCount: 0 };
  }
  return { reading: state.reading, candidate: next, candidateCount };
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
  // another person's face or an empty frame in attendance evidence.
  if (verdict === 'MULTIPLE_PEOPLE' || verdict === 'NO_PERSON') return false;
  if (overridden || verdict === 'UNAVAILABLE') return true;
  return verdict === 'FULL_BODY' && steadyForMs >= STEADY_MS;
}
