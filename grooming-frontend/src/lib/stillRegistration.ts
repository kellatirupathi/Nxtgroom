/**
 * Where a full-resolution still photograph sits relative to the live video.
 *
 * The camera's video stream is one to two megapixels; a still photograph from
 * the same camera is usually eight to twelve. Both show the same scene, but
 * not necessarily the same part of it or the same way up: the still may cover
 * more of the sensor than the video (a 4:3 photograph around a 16:9 video), the
 * video may be a stabilised crop that wanders, and some devices hand back the
 * still sideways. None of that is reported by the browser.
 *
 * So the still is not trusted to line up with what the preview showed. It is
 * aligned against the video frame taken at the moment the camera decided to
 * fire, by searching scale and position for the best normalised correlation
 * between the two, and it is used only when that alignment is decisive. When it
 * is not - a different field of view than any searched, a person who moved in
 * the moment the still took, a scene too plain to align on - the caller keeps
 * the video frame, which is exactly what it would have saved before. The still
 * can only ever improve a photograph, never change what it shows.
 *
 * Pure arithmetic over small grey thumbnails, so every case can be tested
 * without a camera.
 */

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

/** Luminance, row-major, one value per pixel. */
export interface GrayImage {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * still = scale * video + offset, in the pixels of the still once rotated the
 * right way up ("oriented").
 */
export interface StillMapping {
  scale: number;
  offsetX: number;
  offsetY: number;
  /** Normalised cross-correlation at the best alignment, -1 to 1. */
  score: number;
  /** The scale as a multiple of the centred model's, for diagnosis. */
  relativeScale: number;
  /**
   * The best alignment lies on the edge of what was searched, so the true one
   * may lie beyond it. Never trusted.
   */
  atSearchEdge: boolean;
}

/**
 * The range of fields of view searched, relative to the centred model.
 *
 * Above one: the still sees more than the video, as it does when the video is
 * a stabilised or cropped window. Below one: it sees less, as when a still is
 * cut to 4:3 from a wider sensor.
 */
export const MIN_RELATIVE_SCALE = 0.75;
export const MAX_RELATIVE_SCALE = 1.45;
const COARSE_SCALE_STEP = 0.04;
/** Offsets from centred, as a fraction of the still's size. */
const MAX_OFFSET = 0.06;
const COARSE_OFFSET_STEP = 0.02;
const FINE_SCALE_SPAN = 0.04;
const FINE_SCALE_STEP = 0.01;
const FINE_OFFSET_SPAN = 0.02;
const FINE_OFFSET_STEP = 0.005;

/**
 * Below this spread of grey levels a reference has nothing to align on - a
 * blank wall, a covered lens - and any "match" would be noise.
 */
const MIN_REFERENCE_DEVIATION = 3;

/**
 * How far the region may overhang the still, as a fraction of its own size,
 * before it counts as not contained. The overhang is trimmed when drawn.
 *
 * Needed because a region can touch the still's edge exactly - a still the
 * same shape as the video, and a group region using the video's full height.
 * With no allowance, every neighbouring alignment of that perfect one runs off
 * the edge, and the rule that refuses a best pressed against the boundary
 * refused a perfect match. A few percent tells touching from overhanging.
 */
export const REGION_OVERHANG = 0.03;

/** The correlation a still must reach to be trusted. */
export const MIN_MATCH_SCORE = 0.72;
/** How far the right way up must beat the wrong way up. */
export const MIN_ROTATION_MARGIN = 0.1;
/** A still is only worth its extra second if it gives this much more resolution. */
export const MIN_RESOLUTION_GAIN = 1.2;

/** Reference samples across the long side of the region being aligned. */
export const SAMPLES_ON_LONG_SIDE = 40;
/** Thumbnail pixels across that same region in the still, at the centred model. */
export const THUMBNAIL_CROP_LONG_SIDE = 52;

export function orientedSize(size: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

/**
 * The rotations worth trying: those that give the still the video's shape.
 *
 * A still and a video from one sensor are both landscape or both portrait once
 * the right way up. A still of the other shape has been handed over sideways,
 * so only the two quarter turns are candidates; otherwise only upright and
 * upside down.
 */
export function candidateRotations(still: Size, video: Size): Rotation[] {
  const stillLandscape = still.width >= still.height;
  const videoLandscape = video.width >= video.height;
  return stillLandscape === videoLandscape ? [0, 180] : [90, 270];
}

/**
 * The centred model: the video is the largest region of its own shape in the
 * middle of the still. True of most cameras, and the starting point of every
 * search - but only a starting point.
 */
export function expectedScale(oriented: Size, video: Size): number {
  return Math.min(oriented.width / video.width, oriented.height / video.height);
}

/** How many reference samples to take across a region, keeping its shape. */
export function referenceGridSize(region: Size): Size {
  const long = Math.max(region.width, region.height);
  return {
    width: Math.max(12, Math.round((SAMPLES_ON_LONG_SIDE * region.width) / long)),
    height: Math.max(12, Math.round((SAMPLES_ON_LONG_SIDE * region.height) / long)),
  };
}

/** Thumbnail pixels per still pixel, so the region spans THUMBNAIL_CROP_LONG_SIDE. */
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
  // Clamped: within the allowed overhang a sample may fall just outside the
  // still, and takes the value at its edge.
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

/**
 * Normalised cross-correlation of the reference against the still under one
 * alignment. Invariant to brightness and contrast, which differ between a
 * still and a video frame from the same camera. -Infinity when any sample
 * would fall outside the still: a region the still does not contain cannot
 * be cut from it.
 */
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
  // The region must lie inside the still, give or take REGION_OVERHANG.
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
  /** The video region the reference shows, in video pixels. */
  region: Rect;
  /** A small grey rendering of exactly that region. */
  reference: GrayImage;
  video: Size;
  /** A small grey rendering of the whole still, right way up. */
  still: GrayImage;
  /** The still's full size, right way up. */
  stillSize: Size;
}

/**
 * Finds the scale and position that best line the still up with the video.
 *
 * Coarse then fine: a grid over the whole range of fields of view and offsets,
 * then a finer grid around the best of it. The answer is flagged when it lands
 * on the edge of either search, because a best-found at the boundary says only
 * that the real alignment is somewhere further out.
 */
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

  /**
   * A best alignment pressed against the edge of what fits is not an answer.
   *
   * Alignments that would put part of the region outside the still are never
   * scored, so when the true alignment is one of them - the still simply does
   * not contain everything the camera approved - the search settles on the
   * nearest alignment that does fit. On a smooth scene that one still scores
   * well, a sample's shift being hard to see, and it would cut a region a
   * little off from the one intended. Such a best has a neighbour that does
   * not fit; a genuine best is surrounded by ones that do.
   */
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

/**
 * The alignment to trust, if any.
 *
 * Three conditions, each a way a still could show something other than what
 * the camera approved: the match must be strong, it must not sit on the edge
 * of the search, and the right way up must clearly beat the wrong way up -
 * otherwise the scene is too symmetric to say which way the still was turned.
 */
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

/** The region of the (oriented) still that corresponds to a region of the video. */
export function mapRegion(region: Rect, mapping: Pick<StillMapping, 'scale' | 'offsetX' | 'offsetY'>): Rect {
  return {
    x: mapping.scale * region.x + mapping.offsetX,
    y: mapping.scale * region.y + mapping.offsetY,
    width: mapping.scale * region.width,
    height: mapping.scale * region.height,
  };
}

/**
 * Whether a region lies inside the still, allowing REGION_OVERHANG - the same
 * allowance the alignment used - and a pixel of rounding.
 */
export function regionFits(region: Rect, size: Size): boolean {
  if (!(region.width > 0) || !(region.height > 0)) return false;
  const allowX = REGION_OVERHANG * region.width + 1;
  const allowY = REGION_OVERHANG * region.height + 1;
  return region.x >= -allowX
    && region.y >= -allowY
    && region.x + region.width <= size.width + allowX
    && region.y + region.height <= size.height + allowY;
}

/** A size scaled down, never up, to fit within maxDimension on its long side. */
export function fitWithin(size: Size, maxDimension: number): Size {
  const factor = Math.min(1, maxDimension / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * factor)),
    height: Math.max(1, Math.round(size.height * factor)),
  };
}

/**
 * Whether the still is worth using over the video frame.
 *
 * Compared after both are capped to what will be uploaded, because a still
 * that is larger only beyond the cap buys nothing that reaches the server.
 */
export function worthUsing(stillRegion: Size, videoRegion: Size, maxDimension: number): boolean {
  const still = fitWithin(stillRegion, maxDimension);
  const video = fitWithin(videoRegion, maxDimension);
  return Math.max(still.width, still.height) >= MIN_RESOLUTION_GAIN * Math.max(video.width, video.height);
}

/**
 * The canvas transform that draws the raw still so that `region` of its
 * oriented form exactly fills an `output`-sized canvas.
 *
 * Returned as the six setTransform arguments. The oriented still is the raw one
 * turned clockwise by `rotation`; the region is then translated to the origin
 * and scaled to the output.
 */
export function drawTransform(
  raw: Size,
  rotation: Rotation,
  region: Rect,
  output: Size,
): [number, number, number, number, number, number] {
  const { width: W, height: H } = raw;
  // oriented = M * raw + t
  let m00 = 1; let m01 = 0; let m10 = 0; let m11 = 1; let tx = 0; let ty = 0;
  if (rotation === 90) { m00 = 0; m01 = -1; m10 = 1; m11 = 0; tx = H; ty = 0; }
  if (rotation === 180) { m00 = -1; m01 = 0; m10 = 0; m11 = -1; tx = W; ty = H; }
  if (rotation === 270) { m00 = 0; m01 = 1; m10 = -1; m11 = 0; tx = 0; ty = W; }
  const kx = output.width / region.width;
  const ky = output.height / region.height;
  // canvas: x' = a*X + c*Y + e, y' = b*X + d*Y + f
  return [
    kx * m00,
    ky * m10,
    kx * m01,
    ky * m11,
    kx * (tx - region.x),
    ky * (ty - region.y),
  ];
}

/** Applies a setTransform tuple to a point; for tests and for sanity checks. */
export function applyTransform(
  [a, b, c, d, e, f]: [number, number, number, number, number, number],
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}
