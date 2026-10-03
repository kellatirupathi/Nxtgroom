export type Rotation = 0 | 90 | 180 | 270;

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GrayImage {
  data: Float32Array;
  width: number;
  height: number;
}

export interface StillMapping {
  scale: number;
  offsetX: number;
  offsetY: number;
  score: number;
  relativeScale: number;
  atSearchEdge: boolean;
}

export const MIN_RELATIVE_SCALE = 0.75;
export const MAX_RELATIVE_SCALE = 1.45;
const COARSE_SCALE_STEP = 0.04;
const MAX_OFFSET = 0.06;
const COARSE_OFFSET_STEP = 0.02;
const FINE_SCALE_SPAN = 0.04;
const FINE_SCALE_STEP = 0.01;
const FINE_OFFSET_SPAN = 0.02;
const FINE_OFFSET_STEP = 0.005;

const MIN_REFERENCE_DEVIATION = 3;

export const REGION_OVERHANG = 0.03;

export const MIN_MATCH_SCORE = 0.72;
export const MIN_ROTATION_MARGIN = 0.1;
export const MIN_RESOLUTION_GAIN = 1.2;

export const SAMPLES_ON_LONG_SIDE = 40;
export const THUMBNAIL_CROP_LONG_SIDE = 52;

export function orientedSize(size: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

export function candidateRotations(still: Size, video: Size): Rotation[] {
  const stillLandscape = still.width >= still.height;
  const videoLandscape = video.width >= video.height;
  return stillLandscape === videoLandscape ? [0, 180] : [90, 270];
}

export function expectedScale(oriented: Size, video: Size): number {
  return Math.min(oriented.width / video.width, oriented.height / video.height);
}

export function referenceGridSize(region: Size): Size {
  const long = Math.max(region.width, region.height);
  return {
    width: Math.max(12, Math.round((SAMPLES_ON_LONG_SIDE * region.width) / long)),
    height: Math.max(12, Math.round((SAMPLES_ON_LONG_SIDE * region.height) / long)),
  };
}

export function thumbnailScale(oriented: Size, video: Size, region: Size): number {
  return THUMBNAIL_CROP_LONG_SIDE / (expectedScale(oriented, video) * Math.max(region.width, region.height));
}

interface SampleGrid {
  region: Rect;
  u: Float64Array;
  v: Float64Array;
  reference: Float32Array;
  count: number;
  sumR: number;
  varianceR: number;
}

function buildGrid(reference: GrayImage, region: Rect): SampleGrid | null {
  const { width: cols, height: rows } = reference;
  if (cols < 2 || rows < 2 || reference.data.length < cols * rows) return null;
  const u = new Float64Array(cols);
  const v = new Float64Array(rows);
  for (let i = 0; i < cols; i += 1) u[i] = region.x + ((i + 0.5) * region.width) / cols;
  for (let j = 0; j < rows; j += 1) v[j] = region.y + ((j + 0.5) * region.height) / rows;
  const count = cols * rows;
  let sumR = 0;
  let sumRR = 0;
  for (let k = 0; k < count; k += 1) {
    const r = reference.data[k];
    sumR += r;
    sumRR += r * r;
  }
  const varianceR = count * sumRR - sumR * sumR;
  const deviation = Math.sqrt(Math.max(0, varianceR)) / count;
  if (!(deviation >= MIN_REFERENCE_DEVIATION)) return null;
  return { region, u, v, reference: reference.data, count, sumR, varianceR };
}

function bilinear(image: GrayImage, xIn: number, yIn: number): number {
  const x = Math.min(Math.max(xIn, 0), image.width - 1);
  const y = Math.min(Math.max(yIn, 0), image.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, image.width - 1);
  const y1 = Math.min(y0 + 1, image.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const row0 = y0 * image.width;
  const row1 = y1 * image.width;
  const top = image.data[row0 + x0] * (1 - fx) + image.data[row0 + x1] * fx;
  const bottom = image.data[row1 + x0] * (1 - fx) + image.data[row1 + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

function correlation(
  grid: SampleGrid,
  still: GrayImage,
  stillSize: Size,
  kx: number,
  ky: number,
  scale: number,
  offsetX: number,
  offsetY: number,
): number {
  const { u, v, region } = grid;
  const cols = u.length;
  const rows = v.length;
  const left = scale * region.x + offsetX;
  const top = scale * region.y + offsetY;
  const right = left + scale * region.width;
  const bottom = top + scale * region.height;
  const allowX = REGION_OVERHANG * scale * region.width;
  const allowY = REGION_OVERHANG * scale * region.height;
  if (
    left < -allowX
    || top < -allowY
    || right > stillSize.width + allowX
    || bottom > stillSize.height + allowY
  ) {
    return -Infinity;
  }

  let sumS = 0;
  let sumSS = 0;
  let sumRS = 0;
  for (let j = 0; j < rows; j += 1) {
    const y = (scale * v[j] + offsetY) * ky - 0.5;
    const rowOffset = j * cols;
    for (let i = 0; i < cols; i += 1) {
      const s = bilinear(still, (scale * u[i] + offsetX) * kx - 0.5, y);
      sumS += s;
      sumSS += s * s;
      sumRS += grid.reference[rowOffset + i] * s;
    }
  }
  const n = grid.count;
  const varianceS = n * sumSS - sumS * sumS;
  const denominator = Math.sqrt(grid.varianceR * varianceS);
  if (!(denominator > 1e-9)) return -Infinity;
  return (n * sumRS - grid.sumR * sumS) / denominator;
}

export interface RegisterOptions {
  region: Rect;
  reference: GrayImage;
  video: Size;
  still: GrayImage;
  stillSize: Size;
}

export function registerStill({ region, reference, video, still, stillSize }: RegisterOptions): StillMapping | null {
  const grid = buildGrid(reference, region);
  if (!grid) return null;
  if (!(stillSize.width > 0) || !(stillSize.height > 0) || still.width < 2 || still.height < 2) return null;
  const kx = still.width / stillSize.width;
  const ky = still.height / stillSize.height;
  const base = expectedScale(stillSize, video);

  const evaluate = (relative: number, dx: number, dy: number) => {
    const scale = base * relative;
    const offsetX = (stillSize.width - scale * video.width) / 2 + dx * stillSize.width;
    const offsetY = (stillSize.height - scale * video.height) / 2 + dy * stillSize.height;
    return {
      relative,
      dx,
      dy,
      scale,
      offsetX,
      offsetY,
      score: correlation(grid, still, stillSize, kx, ky, scale, offsetX, offsetY),
    };
  };

  let best = { relative: 1, dx: 0, dy: 0, scale: base, offsetX: 0, offsetY: 0, score: -Infinity };
  const scaleSteps = Math.round((MAX_RELATIVE_SCALE - MIN_RELATIVE_SCALE) / COARSE_SCALE_STEP);
  const offsetSteps = Math.round(MAX_OFFSET / COARSE_OFFSET_STEP);
  for (let s = 0; s <= scaleSteps; s += 1) {
    const relative = MIN_RELATIVE_SCALE + s * COARSE_SCALE_STEP;
    for (let oy = -offsetSteps; oy <= offsetSteps; oy += 1) {
      for (let ox = -offsetSteps; ox <= offsetSteps; ox += 1) {
        const candidate = evaluate(relative, ox * COARSE_OFFSET_STEP, oy * COARSE_OFFSET_STEP);
        if (candidate.score > best.score) best = candidate;
      }
    }
  }
  if (!Number.isFinite(best.score)) return null;

  const fineScaleSteps = Math.round(FINE_SCALE_SPAN / FINE_SCALE_STEP);
  const fineOffsetSteps = Math.round(FINE_OFFSET_SPAN / FINE_OFFSET_STEP);
  let fine = best;
  let fineIndex = { s: 0, x: 0, y: 0 };
  for (let s = -fineScaleSteps; s <= fineScaleSteps; s += 1) {
    const relative = best.relative + s * FINE_SCALE_STEP;
    if (relative < MIN_RELATIVE_SCALE - 1e-9 || relative > MAX_RELATIVE_SCALE + 1e-9) continue;
    for (let y = -fineOffsetSteps; y <= fineOffsetSteps; y += 1) {
      for (let x = -fineOffsetSteps; x <= fineOffsetSteps; x += 1) {
        const candidate = evaluate(relative, best.dx + x * FINE_OFFSET_STEP, best.dy + y * FINE_OFFSET_STEP);
        if (candidate.score > fine.score) {
          fine = candidate;
          fineIndex = { s, x, y };
        }
      }
    }
  }

  const onFineEdge = Math.abs(fineIndex.s) === fineScaleSteps
    || Math.abs(fineIndex.x) === fineOffsetSteps
    || Math.abs(fineIndex.y) === fineOffsetSteps;
  const onScaleLimit = fine.relative <= MIN_RELATIVE_SCALE + 1e-6 || fine.relative >= MAX_RELATIVE_SCALE - 1e-6;

  const againstBoundary = [
    [FINE_SCALE_STEP, 0, 0], [-FINE_SCALE_STEP, 0, 0],
    [0, FINE_OFFSET_STEP, 0], [0, -FINE_OFFSET_STEP, 0],
    [0, 0, FINE_OFFSET_STEP], [0, 0, -FINE_OFFSET_STEP],
  ].some(([ds, dx, dy]) => {
    const relative = fine.relative + ds;
    if (relative < MIN_RELATIVE_SCALE - 1e-9 || relative > MAX_RELATIVE_SCALE + 1e-9) return false;
    return !Number.isFinite(evaluate(relative, fine.dx + dx, fine.dy + dy).score);
  });

  return {
    scale: fine.scale,
    offsetX: fine.offsetX,
    offsetY: fine.offsetY,
    score: fine.score,
    relativeScale: fine.relative,
    atSearchEdge: onFineEdge || onScaleLimit || againstBoundary,
  };
}

export interface RotationCandidate {
  rotation: Rotation;
  mapping: StillMapping | null;
}

export function chooseMapping(
  candidates: RotationCandidate[],
): (RotationCandidate & { mapping: StillMapping }) | null {
  const scored = candidates
    .filter((candidate): candidate is RotationCandidate & { mapping: StillMapping } => candidate.mapping !== null)
    .sort((a, b) => b.mapping.score - a.mapping.score);
  const [best, runnerUp] = scored;
  if (!best) return null;
  if (!(best.mapping.score >= MIN_MATCH_SCORE) || best.mapping.atSearchEdge) return null;
  if (runnerUp && best.mapping.score - runnerUp.mapping.score < MIN_ROTATION_MARGIN) return null;
  return best;
}

export function mapRegion(region: Rect, mapping: Pick<StillMapping, 'scale' | 'offsetX' | 'offsetY'>): Rect {
  return {
    x: mapping.scale * region.x + mapping.offsetX,
    y: mapping.scale * region.y + mapping.offsetY,
    width: mapping.scale * region.width,
    height: mapping.scale * region.height,
  };
}

export function regionFits(region: Rect, size: Size): boolean {
  if (!(region.width > 0) || !(region.height > 0)) return false;
  const allowX = REGION_OVERHANG * region.width + 1;
  const allowY = REGION_OVERHANG * region.height + 1;
  return region.x >= -allowX
    && region.y >= -allowY
    && region.x + region.width <= size.width + allowX
    && region.y + region.height <= size.height + allowY;
}

export function fitWithin(size: Size, maxDimension: number): Size {
  const factor = Math.min(1, maxDimension / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * factor)),
    height: Math.max(1, Math.round(size.height * factor)),
  };
}

export function worthUsing(stillRegion: Size, videoRegion: Size, maxDimension: number): boolean {
  const still = fitWithin(stillRegion, maxDimension);
  const video = fitWithin(videoRegion, maxDimension);
  return Math.max(still.width, still.height) >= MIN_RESOLUTION_GAIN * Math.max(video.width, video.height);
}

export function drawTransform(
  raw: Size,
  rotation: Rotation,
  region: Rect,
  output: Size,
): [number, number, number, number, number, number] {
  const { width: W, height: H } = raw;
  let m00 = 1; let m01 = 0; let m10 = 0; let m11 = 1; let tx = 0; let ty = 0;
  if (rotation === 90) { m00 = 0; m01 = -1; m10 = 1; m11 = 0; tx = H; ty = 0; }
  if (rotation === 180) { m00 = -1; m01 = 0; m10 = 0; m11 = -1; tx = W; ty = H; }
  if (rotation === 270) { m00 = 0; m01 = 1; m10 = -1; m11 = 0; tx = 0; ty = W; }
  const kx = output.width / region.width;
  const ky = output.height / region.height;
  return [
    kx * m00,
    ky * m10,
    kx * m01,
    ky * m11,
    kx * (tx - region.x),
    ky * (ty - region.y),
  ];
}

export function applyTransform(
  [a, b, c, d, e, f]: [number, number, number, number, number, number],
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}
