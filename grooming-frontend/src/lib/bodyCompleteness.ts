/**
 * Whether one person is in the frame from head to feet.
 *
 * Both cameras need this answer and neither could get it from a keypoint
 * count alone. MoveNet predicts every joint whether or not it can see it: a
 * person cut off at the knees still comes back with two "ankles", often scored
 * above the general confidence floor and placed near the knees or pushed to the
 * bottom edge of the frame. Counting them as feet is how a half-body frame gets
 * photographed, and a half-body photograph leaves most of the grooming report
 * with nothing to say.
 *
 * So feet are held to a stricter standard than the rest of the body, in three
 * ways that each catch a different kind of invented ankle:
 *
 *   - a higher confidence floor, because a predicted joint scores lower than a
 *     seen one;
 *   - a margin above the bottom of the frame, because a joint the model could
 *     not see is pushed to the edge;
 *   - the shape of a standing leg - hip above knee above ankle, with a shin at
 *     least a fair fraction of the thigh - because an ankle invented for legs
 *     that end at the knee lands just below that knee, and one invented for
 *     legs that end at the waist lands wherever the model likes.
 *
 * The bottom margin is the outline's own bottom edge, taken from the same
 * constant that draws it. A rule stricter than the outline is a rule nobody
 * can follow: somebody standing exactly where the screen told them to stand
 * would be told to step back, and stepping back would take them out of the
 * distance rule, and they would shuffle between the two until the manual
 * button appeared. That is the failure this file must never reintroduce.
 *
 * Imports only the geometry constant, which itself imports nothing, so both
 * detectors can use this without a cycle. The confidence floor arrives as an
 * argument for the same reason.
 */

import { BODY_GUIDE_BOUNDS } from './cameraGeometry.ts';

export interface BodyKeypoint {
  name?: string;
  score?: number;
  x?: number;
  y?: number;
}

/** What is missing, in the order somebody should be told about it. */
export type BodyProblem = 'FEET' | 'HEAD' | 'LEGS' | 'TORSO';

export interface BodyAssessment {
  complete: boolean;
  problem: BodyProblem | null;
}

/**
 * The floor for an ankle to count as seen.
 *
 * Above the general keypoint floor on purpose. A predicted ankle for legs that
 * are out of frame typically scores between the two, and an ankle the model can
 * actually see scores well above this.
 */
export const ANKLE_CONFIDENCE = 0.45;

/**
 * Feet must sit above the bottom of the frame by this much.
 *
 * Exactly the strip below the drawn outline, so the gate and the outline agree
 * about where feet may be. A joint the model could not see is pushed to the
 * frame edge, and this is what catches it - without ever refusing somebody
 * whose feet are inside the shape they were asked to stand in.
 */
export const FEET_BOTTOM_MARGIN = Number(
  (1 - (BODY_GUIDE_BOUNDS.top + BODY_GUIDE_BOUNDS.height)).toFixed(4),
);

/** The eyes and nose must sit below the top of the frame by this much. */
export const HEAD_TOP_MARGIN = 0.03;

/**
 * The shortest a shin may be, as a fraction of the thigh above it.
 *
 * Standing, the two are about equal in the image. An ankle invented for legs
 * that end at the knee lands just below that knee, giving a shin a small
 * fraction of the thigh; a real shin never does.
 */
export const MIN_SHIN_TO_THIGH = 0.45;

const HEAD = ['nose', 'left_eye', 'right_eye'];
const SIDES = ['left', 'right'] as const;

function usable(
  keypoints: BodyKeypoint[],
  name: string,
  minScore: number,
): BodyKeypoint | undefined {
  return keypoints.find((point) => (
    point.name === name
    && (point.score ?? 0) >= minScore
    && Number.isFinite(point.x)
    && Number.isFinite(point.y)
  ));
}

export interface BodyOptions {
  /** Omitted when the frame size is unknown; the edge margins are then skipped. */
  frameHeight?: number;
  /** The general keypoint floor. Ankles use ANKLE_CONFIDENCE regardless. */
  minScore?: number;
}

/**
 * Whether these keypoints describe a whole standing person.
 *
 * Standing, specifically. An attendance photograph is of somebody standing in
 * front of a tablet, and a leg whose knee is above its hip is not a leg the
 * model saw - it is one it invented for a body that ends at the waist. There
 * is no sitting case to allow for here.
 *
 * The first problem found is the one reported, in the order the instructions
 * are most useful: feet first, because "step back" fixes almost everything
 * else as well; then the head, then legs, then torso.
 */
export function assessBody(
  keypoints: BodyKeypoint[] | undefined,
  { frameHeight, minScore = 0.35 }: BodyOptions = {},
): BodyAssessment {
  const points = keypoints || [];
  const feetLimit = frameHeight ? frameHeight * (1 - FEET_BOTTOM_MARGIN) : Infinity;
  const headLimit = frameHeight ? frameHeight * HEAD_TOP_MARGIN : -Infinity;

  // Feet, and the leg above each of them.
  for (const side of SIDES) {
    const ankle = usable(points, `${side}_ankle`, ANKLE_CONFIDENCE);
    if (!ankle) return { complete: false, problem: 'FEET' };
    if ((ankle.y as number) > feetLimit) return { complete: false, problem: 'FEET' };

    const hip = usable(points, `${side}_hip`, minScore);
    const knee = usable(points, `${side}_knee`, minScore);
    if (hip && knee) {
      const thigh = (knee.y as number) - (hip.y as number);
      // A knee at or above its hip belongs to legs the model did not see.
      if (thigh <= 0) return { complete: false, problem: 'LEGS' };
      const shin = (ankle.y as number) - (knee.y as number);
      if (shin < thigh * MIN_SHIN_TO_THIGH) return { complete: false, problem: 'FEET' };
    }
  }

  // Head: two of nose and eyes, and not pressed against the top of the frame.
  const head = HEAD.map((name) => usable(points, name, minScore)).filter(Boolean) as BodyKeypoint[];
  if (head.length < 2) return { complete: false, problem: 'HEAD' };
  if (head.some((point) => (point.y as number) < headLimit)) {
    return { complete: false, problem: 'HEAD' };
  }

  // Legs and torso, both sides of each.
  for (const side of SIDES) {
    if (!usable(points, `${side}_knee`, minScore)) return { complete: false, problem: 'LEGS' };
  }
  for (const side of SIDES) {
    if (!usable(points, `${side}_shoulder`, minScore) || !usable(points, `${side}_hip`, minScore)) {
      return { complete: false, problem: 'TORSO' };
    }
  }

  return { complete: true, problem: null };
}

/** What to tell one person about what is missing. */
export function describeBodyProblem(problem: BodyProblem | null): string | null {
  switch (problem) {
    case 'FEET':
      return 'Step back so your whole body, head to feet, is in the frame';
    case 'HEAD':
      return 'Step back so your whole head is in the frame';
    case 'LEGS':
      return 'Step back so your legs and feet are in the frame';
    case 'TORSO':
      return 'Stand facing the camera with your whole body visible';
    default:
      return null;
  }
}

/**
 * A two-word version, for the chip under somebody's face in a group.
 *
 * There is no room for a sentence under a face, and in a group the sentence is
 * already on the screen. The chip's job is to say which person it is about.
 */
export function shortBodyProblem(problem: BodyProblem | null): string | null {
  switch (problem) {
    case 'FEET':
    case 'LEGS':
    case 'HEAD':
      return 'Step back';
    case 'TORSO':
      return 'Whole body';
    default:
      return null;
  }
}
