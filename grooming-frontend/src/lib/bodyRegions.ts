import type { Keypoint } from './fullBodyDetector.ts';

/**
 * Where the waist, the trousers and the shoes are in the photograph, sent
 * with it so the report can look at each close up in the same request
 * (grooming_api_node/src/services/detailCheck.js).
 *
 * The camera already finds the person's shoulders, hips, knees and ankles to
 * decide when to take the picture, in the same frame the photograph is cut
 * from (bodyGuideSourceRect and readFrame crop the same region), so these
 * boxes need no further work and no request. Each is [ymin, xmin, ymax, xmax]
 * on a 0-1000 scale of that frame, the format the server and the model use.
 *
 * Generous on purpose: the server widens them again, and a box that cuts off
 * a buckle is worse than one that includes a little arm.
 */

export type RegionBox = [number, number, number, number];

export interface BodyRegions {
  head?: RegionBox;
  waist?: RegionBox;
  legs?: RegionBox;
  feet?: RegionBox;
}

/** What the camera knows about a photograph beyond its pixels. */
export interface CaptureDetails {
  bodyRegions?: BodyRegions | null;
}

/** The form field the attendance routes read the regions from. */
export const BODY_REGIONS_FIELD = 'body_regions';

const MIN_SCORE = 0.35;

function toBox(top: number, left: number, bottom: number, right: number, width: number, height: number): RegionBox | undefined {
  const scale = (value: number, size: number) => Math.round(Math.max(0, Math.min(1000, (value / size) * 1000)));
  const box: RegionBox = [scale(top, height), scale(left, width), scale(bottom, height), scale(right, width)];
  return box[2] - box[0] >= 10 && box[3] - box[1] >= 10 ? box : undefined;
}

export function bodyRegionsFromKeypoints(
  keypoints: Keypoint[] | undefined,
  frameWidth: number,
  frameHeight: number,
): BodyRegions | null {
  if (!keypoints?.length || !(frameWidth > 0) || !(frameHeight > 0)) return null;
  const find = (name: string) => keypoints.find((point) => (
    point.name === name
    && (point.score ?? 0) >= MIN_SCORE
    && Number.isFinite(point.x)
    && Number.isFinite(point.y)
  )) as (Keypoint & { x: number; y: number }) | undefined;

  const leftShoulder = find('left_shoulder');
  const rightShoulder = find('right_shoulder');
  const leftHip = find('left_hip');
  const rightHip = find('right_hip');
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return null;

  const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
  const hipY = (leftHip.y + rightHip.y) / 2;
  const torso = hipY - shoulderY;
  if (!(torso > 0)) return null;
  const hipX = (leftHip.x + rightHip.x) / 2;
  const halfWidth = Math.max(Math.abs(leftShoulder.x - rightShoulder.x), Math.abs(leftHip.x - rightHip.x)) / 2;

  const regions: BodyRegions = {};
  // The head, for the hair, beard and moustache: from above the hair to the
  // collar, a little wider than the ears. Measured from the eyes to the
  // shoulders, which the camera finds whichever way the head is turned.
  const leftEye = find('left_eye');
  const rightEye = find('right_eye');
  const nose = find('nose');
  const eyeY = leftEye && rightEye ? (leftEye.y + rightEye.y) / 2 : nose?.y;
  const faceX = nose ? nose.x : leftEye && rightEye ? (leftEye.x + rightEye.x) / 2 : undefined;
  if (eyeY !== undefined && faceX !== undefined && shoulderY - eyeY > 0) {
    const drop = shoulderY - eyeY;
    const leftEar = find('left_ear');
    const rightEar = find('right_ear');
    const halfFace = Math.max(leftEar && rightEar ? Math.abs(leftEar.x - rightEar.x) * 0.8 : 0, drop * 0.75);
    regions.head = toBox(eyeY - 0.95 * drop, faceX - halfFace, shoulderY + 0.05 * drop, faceX + halfFace, frameWidth, frameHeight);
  }
  // The waistband sits a little above the hip joints the model finds: from
  // just under the lowest shirt buttons to the top of the thighs, hip to hip
  // with the hands that often rest there.
  regions.waist = toBox(
    hipY - 0.45 * torso,
    hipX - halfWidth - 0.35 * torso,
    hipY + 0.25 * torso,
    hipX + halfWidth + 0.35 * torso,
    frameWidth,
    frameHeight,
  );

  const leftAnkle = find('left_ankle');
  const rightAnkle = find('right_ankle');
  if (leftAnkle && rightAnkle) {
    const ankleY = Math.max(leftAnkle.y, rightAnkle.y);
    const legXs = [leftHip, rightHip, find('left_knee'), find('right_knee'), leftAnkle, rightAnkle]
      .filter((point): point is Keypoint & { x: number; y: number } => Boolean(point))
      .map((point) => point.x);
    regions.legs = toBox(
      hipY - 0.15 * torso,
      Math.min(...legXs) - 0.3 * torso,
      ankleY + 0.15 * torso,
      Math.max(...legXs) + 0.3 * torso,
      frameWidth,
      frameHeight,
    );
    // The shoe reaches below and in front of the ankle joint.
    regions.feet = toBox(
      ankleY - 0.25 * torso,
      Math.min(leftAnkle.x, rightAnkle.x) - 0.35 * torso,
      ankleY + 0.4 * torso,
      Math.max(leftAnkle.x, rightAnkle.x) + 0.35 * torso,
      frameWidth,
      frameHeight,
    );
  }

  for (const key of Object.keys(regions) as (keyof BodyRegions)[]) {
    if (!regions[key]) delete regions[key];
  }
  return Object.keys(regions).length ? regions : null;
}
