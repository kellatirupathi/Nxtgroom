import { BODY_GUIDE_BOUNDS } from './cameraGeometry.ts';

export interface BodyKeypoint {
  name?: string;
  score?: number;
  x?: number;
  y?: number;
}

export type BodyProblem = 'FEET' | 'HEAD' | 'LEGS' | 'TORSO';

export interface BodyAssessment {
  complete: boolean;
  problem: BodyProblem | null;
}

export const ANKLE_CONFIDENCE = 0.45;

export const FEET_BOTTOM_MARGIN = Math.max(
  0.02,
  Number((1 - (BODY_GUIDE_BOUNDS.top + BODY_GUIDE_BOUNDS.height)).toFixed(4)),
);

export const HEAD_TOP_MARGIN = 0.03;

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
  frameHeight?: number;
  minScore?: number;
}

export function assessBody(
  keypoints: BodyKeypoint[] | undefined,
  { frameHeight, minScore = 0.35 }: BodyOptions = {},
): BodyAssessment {
  const points = keypoints || [];
  const feetLimit = frameHeight ? frameHeight * (1 - FEET_BOTTOM_MARGIN) : Infinity;
  const headLimit = frameHeight ? frameHeight * HEAD_TOP_MARGIN : -Infinity;

  for (const side of SIDES) {
    const ankle = usable(points, `${side}_ankle`, ANKLE_CONFIDENCE);
    if (!ankle) return { complete: false, problem: 'FEET' };
    if ((ankle.y as number) > feetLimit) return { complete: false, problem: 'FEET' };

    const hip = usable(points, `${side}_hip`, minScore);
    const knee = usable(points, `${side}_knee`, minScore);
    if (hip && knee) {
      const thigh = (knee.y as number) - (hip.y as number);
      if (thigh <= 0) return { complete: false, problem: 'LEGS' };
      const shin = (ankle.y as number) - (knee.y as number);
      if (shin < thigh * MIN_SHIN_TO_THIGH) return { complete: false, problem: 'FEET' };
    }
  }

  const head = HEAD.map((name) => usable(points, name, minScore)).filter(Boolean) as BodyKeypoint[];
  if (head.length < 2) return { complete: false, problem: 'HEAD' };
  if (head.some((point) => (point.y as number) < headLimit)) {
    return { complete: false, problem: 'HEAD' };
  }

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
