import {
  duplicatePose,
  HEAD_KEYPOINTS,
  isDetectedPerson,
  KEYPOINT_CONFIDENCE,
  measureFrameQuality,
  MIN_FRAME_BRIGHTNESS,
  MIN_FRAME_SHARPNESS,
  type Detector,
  type Pose,
} from './fullBodyDetector.ts';
import { coverSourceRect } from './cameraGeometry.ts';
import { faceBoxesFromPoses, type BoxPose, type FaceBox } from './faceBoxes.ts';
import { assessBody, shortBodyProblem } from './bodyCompleteness.ts';

export type GroupVerdict =
  | 'GROUP_READY'
  | 'BODIES_CUT'
  | 'FACES_HIDDEN'
  | 'TOO_FEW'
  | 'TOO_MANY'
  | 'NO_PEOPLE'
  | 'UNAVAILABLE';

export interface GroupReading {
  verdict: GroupVerdict;
  guidance: string | null;
  people: number;
  faces: number;
  boxes?: FaceBox[];
}

export const GROUP_MAX_PEOPLE = 6;

export const GROUP_MIN_PEOPLE = 2;

export const GROUP_CAPTURE_CONFIRMATIONS = 4;

export const GROUP_FALLBACK_ATTEMPTS = 15;

export function faceIsVisible(pose: Pose): boolean {
  const seen = pose.keypoints.filter((point) => (
    point.name != null
    && HEAD_KEYPOINTS.includes(point.name)
    && (point.score ?? 0) >= KEYPOINT_CONFIDENCE
  ));
  return seen.length >= 2;
}

export function distinctPeople(poses: Pose[] | undefined, frameHeight?: number): Pose[] {
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
  return people;
}

function bodyIsWhole(pose: Pose, frameHeight?: number): boolean {
  return assessBody(pose.keypoints, { frameHeight, minScore: KEYPOINT_CONFIDENCE }).complete;
}

export function boxLabel(pose: BoxPose, frameHeight?: number): string | null {
  if (!faceIsVisible(pose)) return 'Face the camera';
  const body = assessBody(pose.keypoints, { frameHeight, minScore: KEYPOINT_CONFIDENCE });
  return shortBodyProblem(body.problem);
}

export function groupBoxes(
  poses: Pose[] | undefined,
  { frameWidth, frameHeight, mirrored }: { frameWidth: number; frameHeight: number; mirrored?: boolean },
): FaceBox[] {
  return faceBoxesFromPoses(distinctPeople(poses, frameHeight), {
    frameWidth,
    frameHeight,
    mirrored,
    minScore: KEYPOINT_CONFIDENCE,
    labelFor: (pose) => boxLabel(pose, frameHeight),
  });
}

export function readGroupPoses(poses: Pose[] | undefined, frameHeight?: number): GroupReading {
  const people = distinctPeople(poses, frameHeight);
  const faces = people.filter(faceIsVisible).length;

  if (people.length === 0) {
    return { verdict: 'NO_PEOPLE', guidance: 'Step into the frame together', people: 0, faces: 0 };
  }
  if (people.length < GROUP_MIN_PEOPLE) {
    return {
      verdict: 'TOO_FEW',
      guidance: 'Only one person — use single check-in, or bring the others in',
      people: people.length,
      faces,
    };
  }
  if (people.length > GROUP_MAX_PEOPLE) {
    return {
      verdict: 'TOO_MANY',
      guidance: `Too many people — ${GROUP_MAX_PEOPLE} at a time`,
      people: people.length,
      faces,
    };
  }
  if (faces < people.length) {
    const hidden = people.length - faces;
    return {
      verdict: 'FACES_HIDDEN',
      guidance: hidden === 1
        ? 'One person is not facing the camera'
        : `${hidden} people are not facing the camera`,
      people: people.length,
      faces,
    };
  }
  const cut = people.filter((person) => !bodyIsWhole(person, frameHeight)).length;
  if (cut > 0) {
    return {
      verdict: 'BODIES_CUT',
      guidance: cut === 1
        ? 'One person is not fully in frame — step back, or step out if not checking in'
        : `${cut} people are not fully in frame — step back so everyone shows head to feet`,
      people: people.length,
      faces,
    };
  }
  return { verdict: 'GROUP_READY', guidance: null, people: people.length, faces };
}

export interface StableGroupState {
  reading: GroupReading;
  candidate: GroupReading | null;
  candidateCount: number;
}

export const INITIAL_GROUP_STATE: StableGroupState = {
  reading: { verdict: 'NO_PEOPLE', guidance: 'Step into the frame together', people: 0, faces: 0 },
  candidate: null,
  candidateCount: 0,
};

export function stabilizeGroupReading(
  state: StableGroupState,
  next: GroupReading,
  confirmations = 3,
): StableGroupState {
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

export function groupCaptureReady(verdict: GroupVerdict, steadyFrames: number): boolean {
  if (verdict !== 'GROUP_READY') return false;
  return steadyFrames >= GROUP_CAPTURE_CONFIRMATIONS;
}

export function groupShutterEnabled(verdict: GroupVerdict): boolean {
  return verdict !== 'NO_PEOPLE' && verdict !== 'TOO_MANY';
}

export function groupFallbackDue(unusableFrames: number): boolean {
  return unusableFrames >= GROUP_FALLBACK_ATTEMPTS;
}

export async function readGroupFrame(
  detector: Detector | null,
  video: HTMLVideoElement,
  viewport?: { width: number; height: number; canvas: HTMLCanvasElement },
  options?: { mirrored?: boolean },
): Promise<GroupReading> {
  if (!detector || !video.videoWidth) {
    return { verdict: 'UNAVAILABLE', guidance: null, people: 0, faces: 0 };
  }
  try {
    let input: HTMLVideoElement | HTMLCanvasElement = video;
    let frameHeight = video.videoHeight;
    if (viewport?.width && viewport.height) {
      const crop = coverSourceRect(video.videoWidth, video.videoHeight, viewport.width, viewport.height);
      const scale = Math.min(1, 480 / Math.max(crop.width, crop.height));
      const canvas = viewport.canvas;
      canvas.width = Math.max(1, Math.round(crop.width * scale));
      canvas.height = Math.max(1, Math.round(crop.height * scale));
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
        input = canvas;
        frameHeight = canvas.height;
      }
    }
    const poses = await detector.estimatePoses(input, { maxPoses: GROUP_MAX_PEOPLE + 1 });
    const boxes = groupBoxes(poses, {
      frameWidth: input instanceof HTMLCanvasElement ? input.width : video.videoWidth,
      frameHeight,
      mirrored: options?.mirrored,
    });
    const reading = readGroupPoses(poses, frameHeight);
    if (reading.verdict !== 'GROUP_READY' || !(input instanceof HTMLCanvasElement)) {
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
      return { ...reading, boxes, verdict: 'FACES_HIDDEN', guidance: 'Move to a brighter area' };
    }
    if (quality.sharpness < MIN_FRAME_SHARPNESS) {
      return { ...reading, boxes, verdict: 'FACES_HIDDEN', guidance: 'Everybody hold still' };
    }
    return { ...reading, boxes };
  } catch {
    return { verdict: 'UNAVAILABLE', guidance: null, people: 0, faces: 0 };
  }
}
