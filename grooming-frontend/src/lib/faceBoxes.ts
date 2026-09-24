/**
 * Where each face is in the live preview, so the camera can draw a box on it.
 *
 * Purely a way of showing people what the camera has found. Nothing here gates
 * a capture, decides a verdict or reaches a server — the two frame gates are
 * unchanged and still decide everything they decided before. A box appearing on
 * somebody's face means the detector can see them, which is worth showing
 * because until now the only feedback was a sentence telling a group of six
 * that "2 people are not facing the camera" without saying which two.
 *
 * Deliberately a leaf: it imports nothing, and the confidence floor arrives as
 * an argument rather than from the detector. That keeps the module free of a
 * cycle with fullBodyDetector, which imports this one.
 *
 * A caveat worth keeping in mind while reading this file. These boxes come from
 * MoveNet's pose keypoints, not from Rekognition's face detection, and the
 * server identifies people with the latter. The two normally agree about where
 * a face is, but a box on screen is not a promise that the person inside it
 * will be recognised — which is why nothing here is ever coloured as though it
 * were.
 */

/** Structurally compatible with MoveNet's output, and with fullBodyDetector's own types. */
export interface BoxKeypoint {
  name?: string;
  score?: number;
  x?: number;
  y?: number;
}

export interface BoxPose {
  keypoints: BoxKeypoint[];
  score?: number;
  /** Present when the detector is tracking, which lets a box keep its identity. */
  id?: number;
}

export interface FaceBox {
  /**
   * Stable between frames where possible, so React animates a box that moved
   * rather than swapping two boxes that did not.
   */
  key: string;
  /** Ratios of the previewed frame, already mirrored for display. */
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * Whether the face is pointed at the camera: two of nose and eyes, the same
   * three landmarks both frame gates judge a face by. Ears are deliberately
   * not counted here even though they shape the box — somebody side-on shows
   * both ears and no eyes, and a green box on them would contradict the line
   * beneath telling them to face the camera.
   */
  confident: boolean;
  /**
   * A short instruction to show under the box, when there is one. Set by the
   * caller, which is the only thing that knows what this person needs to fix;
   * this module only knows where their face is.
   */
  label?: string;
}

/** The landmarks a face box is built from, by the names MoveNet returns. */
const FACE_LANDMARKS = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear'];

/** The landmarks that say a face is pointed this way. Matches the gates' HEAD_KEYPOINTS. */
const FACING_LANDMARKS = ['nose', 'left_eye', 'right_eye'];

/**
 * A head is a little over half a shoulder width across.
 *
 * Used as the scale of last resort. Somebody turned side-on shows one ear and
 * one eye a few pixels apart, and a box drawn from that span alone would be a
 * dot on their cheek — their shoulders are still a reliable measure of how big
 * they are in the frame.
 */
const HEAD_TO_SHOULDER_WIDTH = 0.62;

/** Ear to ear is most of the head, but not the whole of it. */
const LANDMARK_SPAN_TO_HEAD = 1.7;

/** A face is taller than it is wide. */
const HEAD_ASPECT = 1.3;

/**
 * The landmarks sit low in the box: forehead and hair are above the eyes, and
 * only the chin is below them.
 */
const LANDMARK_HEIGHT_FRACTION = 0.58;

/** Never smaller than this fraction of the frame, or the box is not visible. */
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

/**
 * One pose's face, in frame pixels, or null when there is no face to draw.
 *
 * Returns pixels rather than ratios so the caller can mirror and normalise once
 * with the frame dimensions it actually has.
 */
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
    // The landmarks are low in the box, so its centre is above theirs.
    centreY: landmarkCentreY - height * (LANDMARK_HEIGHT_FRACTION - 0.5),
    width,
    height,
    confident: facing.length >= 2,
  };
}

export interface FaceBoxOptions {
  frameWidth: number;
  frameHeight: number;
  /**
   * The preview is flipped for the front camera, because an unmirrored
   * self-view is disorienting. The boxes are drawn outside that flip, so they
   * have to be mirrored here instead — otherwise every box lands on the
   * opposite side of the screen from the face it belongs to.
   */
  mirrored?: boolean;
  /** At most this many, largest first. One, for the single-person camera. */
  limit?: number;
  minScore?: number;
  /**
   * What to write under this person's box, or null for nothing. Given the
   * whole pose, because what needs fixing - a hidden face, feet out of frame -
   * is a judgement about the person, not the face.
   */
  labelFor?: (pose: BoxPose) => string | null;
}

/** Every face in a frame, as ratios ready to position with. */
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
    // Largest first, so a limit of one keeps the person nearest the camera
    // rather than whoever the model happened to list first.
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
        // A tracked id survives a person moving; without tracking the position
        // is the next best thing, and it is rounded so a pixel of jitter does
        // not look like a different box arriving.
        key: pose.id != null ? `t${pose.id}` : `p${Math.round(left * 50)}`,
        left: clamp01(left),
        top: clamp01(top),
        width: Math.min(width, 1),
        height: Math.min(height, 1),
        confident: box.confident,
        ...(label ? { label } : {}),
      };
    })
    // Left to right, so the keys stay in reading order and React does not
    // reorder the elements underneath a CSS transition.
    .sort((a, b) => a.left - b.left);
}

/**
 * What each box's chip said last, so it does not change on every reading.
 *
 * Keyed by the box key. Entries for boxes that have left the frame are dropped
 * each time, so the memory is never larger than the number of faces on screen.
 */
export interface LabelMemory {
  [key: string]: {
    /** The label currently shown, or null for no chip. */
    label: string | null;
    /** A different label seen recently, and how many times in a row. */
    candidate: string | null;
    count: number;
  };
}

/**
 * Holds each chip steady until its replacement has been seen several times.
 *
 * The positions of the boxes follow the live reading on purpose, because a box
 * that lagged its face would look broken. The chips cannot, because they are
 * built from thresholds: an ankle score wandering across 0.45 five times a
 * second would make "Step back" flash under somebody's face like a fault
 * light. A label has to be reported this many consecutive times before it
 * replaces the one showing. The first label a new face arrives with is shown
 * at once, so somebody stepping into frame gets their instruction immediately.
 */
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

/** The same boxes with no chips, for a frame the camera is about to take. */
export function withoutLabels(boxes: FaceBox[]): FaceBox[] {
  return boxes.map(({ label: _label, ...rest }) => rest);
}
