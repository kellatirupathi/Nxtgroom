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

const FACE_LANDMARKS = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear'];

const FACING_LANDMARKS = ['nose', 'left_eye', 'right_eye'];

const HEAD_TO_SHOULDER_WIDTH = 0.62;

const LANDMARK_SPAN_TO_HEAD = 1.7;

const HEAD_ASPECT = 1.3;

const LANDMARK_HEIGHT_FRACTION = 0.58;

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

function shoulderWidth(keypoints: BoxKeypoint[], minScore: number): number {
  const shoulders = usablePoints(keypoints, ['left_shoulder', 'right_shoulder'], minScore);
  if (shoulders.length < 2) return 0;
  return Math.abs((shoulders[0].x as number) - (shoulders[1].x as number));
}

export function faceBoxPixels(
  pose: BoxPose,
  minScore: number,
): { centreX: number; centreY: number; width: number; height: number; confident: boolean } | null {
  const landmarks = usablePoints(pose?.keypoints || [], FACE_LANDMARKS, minScore);
  if (landmarks.length === 0) return null;

  const xs = landmarks.map((point) => point.x as number);
  const ys = landmarks.map((point) => point.y as number);
  const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const landmarkCentreY = (Math.min(...ys) + Math.max(...ys)) / 2;

  const fromLandmarks = (Math.max(...xs) - Math.min(...xs)) * LANDMARK_SPAN_TO_HEAD;
  const fromShoulders = shoulderWidth(pose.keypoints, minScore) * HEAD_TO_SHOULDER_WIDTH;
  const width = Math.max(fromLandmarks, fromShoulders);
  if (!(width > 0)) return null;

  const height = width * HEAD_ASPECT;
  const facing = usablePoints(pose.keypoints, FACING_LANDMARKS, minScore);
  return {
    centreX,
    centreY: landmarkCentreY - height * (LANDMARK_HEIGHT_FRACTION - 0.5),
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
