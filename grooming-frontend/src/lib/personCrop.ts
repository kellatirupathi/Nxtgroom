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

// The small photo on an ID card hanging below someone's face is found as a
// face too. A face much smaller than one just above it, in the same column,
// is that card, not a person.
export function dropBadgeFaces<T extends Box>(faces: readonly T[]): T[] {
  return faces.filter((small) => !faces.some((big) => {
    if (big === small || big.width < small.width * 1.6) return false;
    const bigCentre = big.left + big.width / 2;
    const smallCentre = small.left + small.width / 2;
    const below = small.top - (big.top + big.height);
    return Math.abs(bigCentre - smallCentre) < big.width * 1.2
      && below > -small.height * 0.5
      && below < big.height * 6;
  }));
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
