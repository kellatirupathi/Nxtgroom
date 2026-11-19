export interface BoxKeypoint {
  name?: string;
  score?: number;
  x?: number;
  y?: number;
}

export interface BoxPose {
  keypoints: BoxKeypoint[];
  score?: number;
  id?: number;
}

export interface FaceBox {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  confident: boolean;
  label?: string;
}

import { rectToFrame, type QuarterTurn } from './frameTurn.ts';

const FACE_LANDMARKS = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear'];

const FACING_LANDMARKS = ['nose', 'left_eye', 'right_eye'];

// Head breadth (ear to ear) from whatever the detector found. Proportions of
// an adult head: the eyes are about 0.42 of its breadth apart, the ears sit at
// its sides, the shoulders are about 2.5 head breadths wide, and the tip of
// the nose is about 0.3 head breadths below the eyes.
const EYE_SPAN_TO_HEAD = 2.4;
const EAR_SPAN_TO_HEAD = 1;
const SHOULDER_SPAN_TO_HEAD = 0.4;
const EYE_TO_NOSE_TO_HEAD = 3.3;
const NOSE_BELOW_EYES = 0.3;
const EARS_BELOW_EYES = 0.05;

// Shoulders are only a rough guide; when the face itself gives a size, they
// may enlarge it by at most this much.
const MAX_SHOULDER_OVER_FACE = 1.6;

// The box is a quarter wider than the head so hair and ears fit inside it,
// and 1.3 times as tall as it is wide, which reaches from above the hairline
// to below the chin when it is centred on the eyes.
const BOX_TO_HEAD = 1.25;
const HEAD_ASPECT = 1.3;
const BOX_RAISE = 0.03;

const MIN_BOX_RATIO = 0.03;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function usablePoints(
  keypoints: BoxKeypoint[],
  names: readonly string[],
  minScore: number,
): BoxKeypoint[] {
  return keypoints.filter((point) => (
    point.name != null
    && names.includes(point.name)
    && (point.score ?? 0) >= minScore
    && Number.isFinite(point.x)
    && Number.isFinite(point.y)
  ));
}

function pointNamed(points: BoxKeypoint[], name: string): BoxKeypoint | undefined {
  return points.find((point) => point.name === name);
}

function span(first: BoxKeypoint | undefined, second: BoxKeypoint | undefined): number {
  return first && second ? Math.abs((first.x as number) - (second.x as number)) : 0;
}

function midpoint(first: BoxKeypoint, second: BoxKeypoint): { x: number; y: number } {
  return {
    x: ((first.x as number) + (second.x as number)) / 2,
    y: ((first.y as number) + (second.y as number)) / 2,
  };
}

export function faceBoxPixels(
  pose: BoxPose,
  minScore: number,
): { centreX: number; centreY: number; width: number; height: number; confident: boolean } | null {
  const landmarks = usablePoints(pose?.keypoints || [], FACE_LANDMARKS, minScore);
  if (landmarks.length === 0) return null;

  const nose = pointNamed(landmarks, 'nose');
  const leftEye = pointNamed(landmarks, 'left_eye');
  const rightEye = pointNamed(landmarks, 'right_eye');
  const leftEar = pointNamed(landmarks, 'left_ear');
  const rightEar = pointNamed(landmarks, 'right_ear');
  const shoulders = usablePoints(pose.keypoints, ['left_shoulder', 'right_shoulder'], minScore);
  const eyes = [leftEye, rightEye].filter((point): point is BoxKeypoint => Boolean(point));
  const eyeY = eyes.length ? eyes.reduce((sum, point) => sum + (point.y as number), 0) / eyes.length : null;

  const fromFace = Math.max(
    span(leftEye, rightEye) * EYE_SPAN_TO_HEAD,
    span(leftEar, rightEar) * EAR_SPAN_TO_HEAD,
    nose && eyeY !== null && (nose.y as number) > eyeY ? ((nose.y as number) - eyeY) * EYE_TO_NOSE_TO_HEAD : 0,
  );
  const fromShoulders = shoulders.length >= 2 ? span(shoulders[0], shoulders[1]) * SHOULDER_SPAN_TO_HEAD : 0;
  const head = fromFace > 0
    ? Math.max(fromFace, Math.min(fromShoulders, fromFace * MAX_SHOULDER_OVER_FACE))
    : fromShoulders;
  if (!(head > 0)) return null;

  const centreX = leftEar && rightEar
    ? midpoint(leftEar, rightEar).x
    : leftEye && rightEye
      ? midpoint(leftEye, rightEye).x
      : nose
        ? nose.x as number
        : landmarks.reduce((sum, point) => sum + (point.x as number), 0) / landmarks.length;
  const ears = [leftEar, rightEar].filter((point): point is BoxKeypoint => Boolean(point));
  const eyeLine = eyeY ?? (nose
    ? (nose.y as number) - head * NOSE_BELOW_EYES
    : ears.reduce((sum, point) => sum + (point.y as number), 0) / ears.length - head * EARS_BELOW_EYES);

  const width = head * BOX_TO_HEAD;
  const height = width * HEAD_ASPECT;
  const facing = usablePoints(pose.keypoints, FACING_LANDMARKS, minScore);
  return {
    centreX,
    centreY: eyeLine - height * BOX_RAISE,
    width,
    height,
    confident: facing.length >= 2,
  };
}

export interface FaceBoxOptions {
  frameWidth: number;
  frameHeight: number;
  mirrored?: boolean;
  limit?: number;
  minScore?: number;
  labelFor?: (pose: BoxPose) => string | null;
}

export function faceBoxesFromPoses(
  poses: BoxPose[] | undefined,
  { frameWidth, frameHeight, mirrored = false, limit = 0, minScore = 0.35, labelFor }: FaceBoxOptions,
): FaceBox[] {
  if (!(frameWidth > 0) || !(frameHeight > 0)) return [];

  const boxes = (poses || [])
    .map((pose) => ({ pose, box: faceBoxPixels(pose, minScore) }))
    .filter((entry): entry is { pose: BoxPose; box: NonNullable<ReturnType<typeof faceBoxPixels>> } => (
      entry.box !== null
    ))
    .sort((a, b) => b.box.width - a.box.width);

  const kept = limit > 0 ? boxes.slice(0, limit) : boxes;

  return kept
    .map(({ pose, box }) => {
      const width = Math.max(box.width / frameWidth, MIN_BOX_RATIO);
      const height = Math.max(box.height / frameHeight, MIN_BOX_RATIO * (frameWidth / frameHeight));
      const centreX = box.centreX / frameWidth;
      const centreY = box.centreY / frameHeight;
      const left = (mirrored ? 1 - centreX : centreX) - width / 2;
      const top = centreY - height / 2;
      const label = labelFor ? labelFor(pose) : null;
      return {
        key: pose.id != null ? `t${pose.id}` : `p${Math.round(left * 50)}`,
        left: clamp01(left),
        top: clamp01(top),
        width: Math.min(width, 1),
        height: Math.min(height, 1),
        confident: box.confident,
        ...(label ? { label } : {}),
      };
    })
    .sort((a, b) => a.left - b.left);
}

// Boxes found in a frame that was turned upright for the detector, moved back
// onto the preview, which shows the frame as the camera delivered it (and
// mirrored, for the front camera). Pass the boxes unmirrored.
export function boxesOnPreview(boxes: FaceBox[], turn: QuarterTurn, mirrored: boolean): FaceBox[] {
  return boxes
    .map((box) => {
      const frame = rectToFrame(box, turn);
      const left = mirrored ? 1 - frame.left - frame.width : frame.left;
      return {
        ...box,
        left: clamp01(left),
        top: clamp01(frame.top),
        width: Math.min(frame.width, 1),
        height: Math.min(frame.height, 1),
      };
    })
    .sort((a, b) => a.left - b.left);
}

export interface LabelMemory {
  [key: string]: {
    label: string | null;
    candidate: string | null;
    count: number;
  };
}

export function stabilizeBoxLabels(
  memory: LabelMemory,
  boxes: FaceBox[],
  confirmations = 3,
): { boxes: FaceBox[]; memory: LabelMemory } {
  const next: LabelMemory = {};
  const stabilised = boxes.map((box) => {
    const seen = box.label ?? null;
    const previous = memory[box.key];
    let entry: LabelMemory[string];
    if (!previous) {
      entry = { label: seen, candidate: null, count: 0 };
    } else if (seen === previous.label) {
      entry = { label: previous.label, candidate: null, count: 0 };
    } else {
      const count = seen === previous.candidate ? previous.count + 1 : 1;
      entry = count >= confirmations
        ? { label: seen, candidate: null, count: 0 }
        : { label: previous.label, candidate: seen, count };
    }
    next[box.key] = entry;
    const { label: _live, ...rest } = box;
    return entry.label ? { ...rest, label: entry.label } : rest;
  });
  return { boxes: stabilised, memory: next };
}

export function withoutLabels(boxes: FaceBox[]): FaceBox[] {
  return boxes.map(({ label: _label, ...rest }) => rest);
}
