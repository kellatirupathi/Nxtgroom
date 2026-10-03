export type FrameVerdict =
  | 'FULL_BODY'
  | 'TOO_FAR'
  | 'PARTIAL'
  | 'NO_PERSON'
  | 'MULTIPLE_PEOPLE'
  | 'UNAVAILABLE';

export interface FrameReading {
  verdict: FrameVerdict;
  guidance: string | null;
  poseSignals?: PoseSignals;
  capturePosture?: CapturePosture;
  bodyRegions?: BodyRegions | null;
  boxes?: FaceBox[];
}

export type WristPosition = 'RAISED' | 'LOWERED' | 'UNKNOWN';

export interface PoseSignals {
  leftWrist: WristPosition;
  rightWrist: WristPosition;
}

export const KEYPOINT_CONFIDENCE = 0.35;

import { BODY_GUIDE_BOUNDS, coverSourceRect } from './cameraGeometry.ts';
import { faceBoxesFromPoses, type FaceBox } from './faceBoxes.ts';
import { assessBody, describeBodyProblem } from './bodyCompleteness.ts';
import { assessCapturePosture, type CapturePosture } from './capturePosture.ts';
import { bodyRegionsFromKeypoints, type BodyRegions } from './bodyRegions.ts';

export const MIN_BODY_SPAN_RATIO = 0.48;
export const HEAD_KEYPOINTS = ['nose', 'left_eye', 'right_eye'];
const REQUIRED_KEYPOINT_GROUPS = [
  ['left_shoulder', 'right_shoulder'],
  ['left_hip', 'right_hip'],
  ['left_knee', 'right_knee'],
  ['left_ankle', 'right_ankle'],
] as const;
const ANKLE_KEYPOINTS = ['left_ankle', 'right_ankle'];

export const MIN_FRAME_BRIGHTNESS = 42;
export const MIN_FRAME_SHARPNESS = 7;

export type Keypoint = { name?: string; score?: number; x?: number; y?: number };
export type Pose = { keypoints: Keypoint[]; score?: number };

export type Detector = {
  estimatePoses: (
    input: HTMLVideoElement | HTMLCanvasElement,
    config?: { maxPoses?: number },
  ) => Promise<Pose[]>;
  dispose?: () => void;
  tracker?: { reset?: () => void };
  moveNetModel?: { execute: (input: unknown) => unknown };
};

type TfCore = typeof import('@tensorflow/tfjs-core');

export const MOVENET_MODEL_URL = '/models/movenet-multipose-lightning-v1/model.json';

const ANALYSIS_MAX_SIDE = 480;
const MULTI_POSE_MAX_DIMENSION = 320;

let detectorPromise: Promise<Detector | null> | null = null;
let detectorSettled = false;
let tfCore: TfCore | null = null;
const preparedShapes = new Map<string, Promise<void>>();

export function fullBodyDetectorSettled(): boolean {
  return detectorSettled;
}

export const DETECTOR_STARTING_GUIDANCE = 'Starting face detection…';

export function analysisSize(viewWidth: number, viewHeight: number): { width: number; height: number } {
  const scale = Math.min(1, ANALYSIS_MAX_SIDE / Math.max(viewWidth, viewHeight));
  return {
    width: Math.max(1, Math.round(viewWidth * scale)),
    height: Math.max(1, Math.round(viewHeight * scale)),
  };
}

export function modelInputShape(width: number, height: number): [number, number] {
  const short = (side: number, long: number) => (
    Math.ceil(Math.round(MULTI_POSE_MAX_DIMENSION * side / long) / 32) * 32
  );
  return width > height
    ? [short(height, width), MULTI_POSE_MAX_DIMENSION]
    : [MULTI_POSE_MAX_DIMENSION, short(width, height)];
}

async function buildPrograms(detector: Detector, [height, width]: [number, number]): Promise<void> {
  const tf = tfCore;
  const model = detector.moveNetModel;
  const backend = tf?.backend() as {
    checkCompileCompletionAsync?: () => Promise<unknown>;
    getUniformLocations?: () => void;
  } | undefined;
  if (!tf || typeof model?.execute !== 'function'
    || !backend?.checkCompileCompletionAsync || !backend.getUniformLocations) {
    return;
  }
  const input = tf.zeros([1, height, width, 3], 'int32');
  let output: unknown;
  tf.env().set('ENGINE_COMPILE_ONLY', true);
  try {
    output = model.execute(input);
  } finally {
    tf.env().set('ENGINE_COMPILE_ONLY', false);
  }
  try {
    await backend.checkCompileCompletionAsync();
    backend.getUniformLocations();
  } finally {
    tf.dispose([input, output as Parameters<TfCore['dispose']>[0]]);
  }
}

export function primeFullBodyDetector(
  detector: Detector | null,
  viewWidth: number,
  viewHeight: number,
): Promise<void> {
  if (!detector || !(viewWidth > 0) || !(viewHeight > 0) || typeof document === 'undefined') {
    return Promise.resolve();
  }
  const { width, height } = analysisSize(viewWidth, viewHeight);
  const key = `${width}x${height}`;
  let preparing = preparedShapes.get(key);
  if (!preparing) {
    preparing = (async () => {
      try {
        await buildPrograms(detector, modelInputShape(width, height));
      } catch {
      }
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')?.fillRect(0, 0, width, height);
        await detector.estimatePoses(canvas);
        detector.tracker?.reset?.();
      } catch {
      }
    })();
    preparedShapes.set(key, preparing);
  }
  return preparing;
}

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
      tfCore = tf;
      try {
        tf.env().set('WEBGL_USE_SHAPES_UNIFORMS', true);
      } catch {
      }
      const config = {
        modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
        enableTracking: true,
        multiPoseMaxDimension: MULTI_POSE_MAX_DIMENSION,
        minPoseScore: 0.15,
      };
      let detector: Detector;
      try {
        detector = await poseDetection.createDetector(
          poseDetection.SupportedModels.MoveNet,
          { ...config, modelUrl: MOVENET_MODEL_URL },
        ) as unknown as Detector;
      } catch {
        detector = await poseDetection.createDetector(
          poseDetection.SupportedModels.MoveNet,
          config,
        ) as unknown as Detector;
      }
      if (typeof window !== 'undefined') {
        await primeFullBodyDetector(detector, window.innerWidth, window.innerHeight);
      }
      return detector;
    } catch {
      return null;
    } finally {
      detectorSettled = true;
    }
  })();
  return detectorPromise;
}

export function preloadFullBodyDetector(): void {
  void loadFullBodyDetector();
}

function wristPosition(
  keypoints: Keypoint[],
  side: 'left' | 'right',
  frameHeight?: number,
): WristPosition {
  const find = (name: string) => keypoints.find((point) => (
    point.name === name
    && (point.score ?? 0) >= KEYPOINT_CONFIDENCE
    && Number.isFinite(point.y)
  ));
  const wrist = find(`${side}_wrist`);
  const shoulder = find(`${side}_shoulder`);
  if (!wrist || !shoulder) return 'UNKNOWN';

  const margin = Math.max(8, (frameHeight || 0) * 0.04);
  if ((wrist.y as number) < (shoulder.y as number) - margin) return 'RAISED';
  if ((wrist.y as number) > (shoulder.y as number) + margin) return 'LOWERED';
  return 'UNKNOWN';
}

function poseSignals(keypoints: Keypoint[], frameHeight?: number): PoseSignals {
  return {
    leftWrist: wristPosition(keypoints, 'left', frameHeight),
    rightWrist: wristPosition(keypoints, 'right', frameHeight),
  };
}

export function readKeypoints(
  keypoints: Keypoint[] | undefined,
  frameHeight?: number,
  frameWidth?: number,
): FrameReading {
  if (!keypoints?.length) {
    return { verdict: 'NO_PERSON', guidance: 'Step into the frame' };
  }
  const seen = (names: readonly string[]) => names.some((name) => keypoints.some(
    (point) => point.name === name && (point.score ?? 0) >= KEYPOINT_CONFIDENCE,
  ));
  const find = (name: string) => keypoints.find((point) => (
    point.name === name
    && (point.score ?? 0) >= KEYPOINT_CONFIDENCE
    && Number.isFinite(point.x)
    && Number.isFinite(point.y)
  ));

  const visibleFacePoints = HEAD_KEYPOINTS.filter((name) => seen([name])).length;
  const headVisible = visibleFacePoints >= 2;
  const anklesVisible = ANKLE_KEYPOINTS.every((name) => seen([name]));

  if (!headVisible && !anklesVisible) {
    return { verdict: 'NO_PERSON', guidance: 'Step into the frame' };
  }
  const missingGroup = REQUIRED_KEYPOINT_GROUPS.find((group) => (
    !group.every((name) => seen([name]))
  ));
  if (headVisible && anklesVisible && !missingGroup) {
    const requiredNames = [
      ...HEAD_KEYPOINTS.filter((name) => find(name)),
      ...REQUIRED_KEYPOINT_GROUPS.flat(),
    ];
    const requiredPoints = requiredNames
      .map((name) => find(name))
      .filter((point): point is Keypoint => Boolean(point));

    if (frameWidth && frameHeight) {
      const left = frameWidth * BODY_GUIDE_BOUNDS.left;
      const right = frameWidth * (BODY_GUIDE_BOUNDS.left + BODY_GUIDE_BOUNDS.width);
      const top = frameHeight * BODY_GUIDE_BOUNDS.top;
      const bottom = frameHeight * (BODY_GUIDE_BOUNDS.top + BODY_GUIDE_BOUNDS.height);
      const belowOutline = requiredPoints.some((point) => (point.y as number) > bottom);
      const outsideElsewhere = requiredPoints.some((point) => (
        (point.x as number) < left
        || (point.x as number) > right
        || (point.y as number) < top
      ));
      if (belowOutline || outsideElsewhere) {
        return {
          verdict: 'PARTIAL',
          guidance: belowOutline && !outsideElsewhere
            ? describeBodyProblem('FEET')
            : 'Center your complete body in the camera',
          poseSignals: poseSignals(keypoints, frameHeight),
        };
      }

      const headY = Math.min(...requiredPoints
        .filter((point) => point.name && HEAD_KEYPOINTS.includes(point.name))
        .map((point) => point.y as number));
      const ankleY = Math.max(
        find('left_ankle')?.y as number,
        find('right_ankle')?.y as number,
      );
      if ((ankleY - headY) / frameHeight < MIN_BODY_SPAN_RATIO) {
        return {
          verdict: 'TOO_FAR',
          guidance: 'Move closer while keeping your full body in the camera',
          poseSignals: poseSignals(keypoints, frameHeight),
        };
      }
    }

    const body = assessBody(keypoints, { frameHeight, minScore: KEYPOINT_CONFIDENCE });
    if (!body.complete) {
      return {
        verdict: 'PARTIAL',
        guidance: describeBodyProblem(body.problem),
        poseSignals: poseSignals(keypoints, frameHeight),
      };
    }

    return {
      verdict: 'FULL_BODY',
      guidance: null,
      poseSignals: poseSignals(keypoints, frameHeight),
      capturePosture: assessCapturePosture(keypoints, frameHeight, frameWidth),
      bodyRegions: frameWidth && frameHeight ? bodyRegionsFromKeypoints(keypoints, frameWidth, frameHeight) : null,
    };
  }
  return {
    verdict: 'PARTIAL',
    poseSignals: poseSignals(keypoints, frameHeight),
    guidance: !headVisible
      ? 'Face the camera with your full head visible'
      : !anklesVisible
        ? 'Step back — both feet must be in frame'
        : 'Stand facing the camera with shoulders, hips and knees visible',
  };
}

export interface StableFrameState {
  reading: FrameReading;
  candidate: FrameReading | null;
  candidateCount: number;
}

export function isDetectedPerson(pose: Pose): boolean {
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

export function duplicatePose(first: Pose, second: Pose, frameHeight?: number): boolean {
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

export function readPoses(
  poses: Pose[] | undefined,
  frameHeight?: number,
  frameWidth?: number,
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
  return readKeypoints(people[0]?.keypoints, frameHeight, frameWidth);
}

export interface FrameQuality {
  brightness: number;
  sharpness: number;
}

export function measureFrameQuality(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): FrameQuality {
  if (width < 3 || height < 3 || pixels.length < width * height * 4) {
    return { brightness: 0, sharpness: 0 };
  }
  let brightnessTotal = 0;
  let sharpnessTotal = 0;
  let samples = 0;
  const luminance = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    return pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
  };
  for (let y = 2; y < height - 2; y += 2) {
    for (let x = 2; x < width - 2; x += 2) {
      const center = luminance(x, y);
      brightnessTotal += center;
      sharpnessTotal += Math.abs(
        (4 * center)
        - luminance(x - 1, y)
        - luminance(x + 1, y)
        - luminance(x, y - 1)
        - luminance(x, y + 1),
      );
      samples += 1;
    }
  }
  return {
    brightness: samples ? brightnessTotal / samples : 0,
    sharpness: samples ? sharpnessTotal / samples : 0,
  };
}

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

export async function readFrame(
  detector: Detector | null,
  video: HTMLVideoElement,
  viewport?: { width: number; height: number; canvas: HTMLCanvasElement },
  options?: { mirrored?: boolean },
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
      const scale = Math.min(1, ANALYSIS_MAX_SIDE / Math.max(crop.width, crop.height));
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
    const frameWidth = input instanceof HTMLCanvasElement ? input.width : video.videoWidth;
    const boxes = faceBoxesFromPoses(poses, {
      frameWidth,
      frameHeight,
      mirrored: options?.mirrored,
      limit: 1,
      minScore: KEYPOINT_CONFIDENCE,
    });
    const reading = readPoses(poses, frameHeight, frameWidth);
    if (reading.verdict !== 'FULL_BODY' || !(input instanceof HTMLCanvasElement)) {
      return { ...reading, boxes };
    }
    const context = input.getContext('2d', { willReadFrequently: true });
    if (!context) return { ...reading, boxes };
    const quality = measureFrameQuality(
      context.getImageData(0, 0, input.width, input.height).data,
      input.width,
      input.height,
    );
    if (quality.brightness < MIN_FRAME_BRIGHTNESS) {
      return { ...reading, boxes, verdict: 'PARTIAL', guidance: 'Move to a brighter area' };
    }
    if (quality.sharpness < MIN_FRAME_SHARPNESS) {
      return { ...reading, boxes, verdict: 'PARTIAL', guidance: 'Hold still for a clear photo' };
    }
    return { ...reading, boxes };
  } catch {
    return { verdict: 'UNAVAILABLE', guidance: null };
  }
}

export const STEADY_MS = 0;
export const OVERRIDE_AFTER_MS = 0;

export function shutterEnabled(
  verdict: FrameVerdict,
  _steadyForMs: number,
  _overridden: boolean,
): boolean {
  if (verdict === 'MULTIPLE_PEOPLE' || verdict === 'NO_PERSON') return false;
  return true;
}

export const AUTO_CAPTURE_CONFIRMATIONS = 3;

export const AUTO_CAPTURE_COOLDOWN_MS = 2_000;

export function captureConfirmationCount(verdict: FrameVerdict, frames: number, busy: boolean, cooldownUntil: number, now: number): number {
  return !busy && now >= cooldownUntil && verdict === 'FULL_BODY' ? frames + 1 : 0;
}

export const AUTO_CAPTURE_FALLBACK_ATTEMPTS = 25;

export function autoCaptureReady(verdict: FrameVerdict, steadyFrames: number): boolean {
  if (verdict !== 'FULL_BODY') return false;
  return steadyFrames >= AUTO_CAPTURE_CONFIRMATIONS;
}

export function autoCaptureFallbackDue(unusableFrames: number): boolean {
  return unusableFrames >= AUTO_CAPTURE_FALLBACK_ATTEMPTS;
}
