// Where each person is in a group photo, worked out in the browser from their
// face: the face detector looks at a small (192 px) picture, so the photo is
// also looked at in overlapping tiles to find faces that are small in it, and
// the person is cut out from the face position with the same body proportions
// the server uses for the group kiosk (services/groupPhotoGeometry.js).
import type { Box } from './groupLabels.ts';

const FACE_BOX_TO_HEAD = 0.78;
const HEADS_PER_BODY = 7.6;
const SHOULDERS_PER_FACE_WIDTH = 3.4;
const BODY_SIDE_MARGIN = 0.12;

export interface FaceSpot extends Box {
  score: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// The person, head to feet, from their face (all as fractions of the photo:
// widths of its width, heights of its height).
export function bodyCropFromFace(face: Box): Box {
  const headHeight = face.height / FACE_BOX_TO_HEAD;
  const crownTop = face.top - (headHeight - face.height);
  const bodyHeight = headHeight * HEADS_PER_BODY;
  const centreX = face.left + face.width / 2;
  const bodyWidth = face.width * SHOULDERS_PER_FACE_WIDTH * (1 + BODY_SIDE_MARGIN * 2);
  const left = clamp(centreX - bodyWidth / 2, 0, 1);
  const top = clamp(crownTop, 0, 1);
  const right = clamp(centreX + bodyWidth / 2, 0, 1);
  const bottom = clamp(crownTop + bodyHeight, 0, 1);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export interface Tile {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The whole photo, then square tiles of half and of a third of its shorter
// side (so both near and far faces are big enough for the detector), each
// overlapping the next by a third so no face is cut in half everywhere.
export function planTiles(width: number, height: number): Tile[] {
  const tiles: Tile[] = [{ x: 0, y: 0, width, height }];
  for (const parts of [2, 3]) {
    const side = Math.round(Math.min(width, height) / parts);
    if (side < 160) continue;
    const stride = Math.round(side * 0.66);
    const starts = (length: number) => {
      const values: number[] = [];
      for (let at = 0; at + side < length; at += stride) values.push(at);
      values.push(Math.max(0, length - side));
      return [...new Set(values)];
    };
    for (const y of starts(height)) {
      for (const x of starts(width)) tiles.push({ x, y, width: side, height: side });
    }
  }
  return tiles;
}

// Things below a person that the face detector takes for a face: the small
// photo on their ID card, and their hands, shoes or the floor near their
// feet. A face is dropped when it is in the same column as a face above it
// and either much smaller and close below (the card), or far down at the
// legs or feet (no one in a group photo is that low: someone sitting on a
// chair in front is only about two faces lower, on the floor about four).
const BADGE_SIZE_RATIO = 1.6;
const BADGE_MAX_DROP_FACES = 6;
const LEGS_START_FACES = 5;

export function dropBodyPartFaces<T extends Box>(faces: readonly T[]): T[] {
  return faces.filter((small) => !faces.some((big) => {
    if (big === small) return false;
    const sideways = Math.abs((big.left + big.width / 2) - (small.left + small.width / 2));
    const below = small.top - (big.top + big.height);
    const drop = (small.top + small.height / 2) - (big.top + big.height / 2);
    const badge = big.width >= small.width * BADGE_SIZE_RATIO
      && sideways < big.width * 1.2
      && below > -small.height * 0.5
      && below < big.height * BADGE_MAX_DROP_FACES;
    const legsOrFeet = small.width < big.width * 1.5
      && sideways < big.width * 1.8
      && drop > big.height * LEGS_START_FACES;
    return badge || legsOrFeet;
  }));
}

// In a group photo everyone's face is about the same size; something found
// at under half the usual size (a pattern on the floor or wall, a poster,
// someone far off in the background) is not one of the group.
export function dropTinyFaces<T extends Box>(faces: readonly T[]): T[] {
  if (faces.length < 3) return [...faces];
  const widths = faces.map((face) => face.width).sort((a, b) => a - b);
  const middle = Math.floor(widths.length / 2);
  const median = widths.length % 2 ? widths[middle] : (widths[middle - 1] + widths[middle]) / 2;
  return faces.filter((face) => face.width >= median * 0.45);
}

export interface FacePoint {
  x: number;
  y: number;
  name?: string;
}

// A real, upright face has its eyes side by side above the nose and the
// mouth below the nose; a shoe, a hand or a floor pattern found as a face
// usually has these points jumbled. Points and box are in the same pixels.
export function uprightFace(points: readonly FacePoint[] | undefined, box: { width: number; height: number }): boolean {
  if (!points || points.length < 4) return true;
  const point = (name: string, index: number) => points.find((item) => item.name === name) ?? points[index];
  const rightEye = point('rightEye', 0);
  const leftEye = point('leftEye', 1);
  const nose = point('noseTip', 2);
  const mouth = point('mouthCenter', 3);
  const eyesY = (rightEye.y + leftEye.y) / 2;
  const eyeGap = Math.abs(rightEye.x - leftEye.x);
  return eyeGap >= box.width * 0.18
    && Math.abs(rightEye.y - leftEye.y) <= eyeGap * 0.6
    && nose.y > eyesY - box.height * 0.02
    && mouth.y > nose.y - box.height * 0.02
    && mouth.y - eyesY >= box.height * 0.12;
}

function overlapRatio(a: Box, b: Box): number {
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  if (width <= 0 || height <= 0) return 0;
  const shared = width * height;
  return shared / Math.min(a.width * a.height, b.width * b.height);
}

// One face per person: the same face found in several tiles (or the whole
// photo) is kept once, from its most confident detection.
export function mergeFaces(faces: readonly FaceSpot[]): FaceSpot[] {
  const kept: FaceSpot[] = [];
  for (const face of [...faces].sort((a, b) => b.score - a.score)) {
    if (kept.some((other) => overlapRatio(face, other) > 0.4)) continue;
    kept.push(face);
  }
  return kept;
}

// People left to right (a back row after the front row it overlaps with).
export function sortLeftToRight<T extends { left: number; width: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.left + a.width / 2) - (b.left + b.width / 2));
}
