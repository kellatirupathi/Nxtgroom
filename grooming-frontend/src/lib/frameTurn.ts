// Camera frames that arrive turned on their side.
//
// An iPad with rotation lock on (or Guided Access with motion off) keeps its
// screen in portrait when it is turned to landscape, and hands the browser
// camera frames in which the people in front of it lie on their side. The
// pose detector only recognises upright people, so it misses them: boxes land
// in the wrong place, auto-capture never fires, and a photo taken by hand is
// stored sideways, so the per-person crops come out cut and wrong.
//
// The camera therefore works the turn out from the picture itself. While it
// sees nobody upright it also tries the frame turned a quarter each way, and
// adopts a turn that shows upright people clearly, twice running. Analysis,
// face boxes, the photograph and the on-screen messages all follow that turn.
// A frame that is already upright keeps turn 0 and behaves exactly as before.

export type QuarterTurn = 0 | 90 | 180 | 270;

export interface TurnSize {
  width: number;
  height: number;
}

export interface TurnRect extends TurnSize {
  x: number;
  y: number;
}

export function isSideways(turn: QuarterTurn): boolean {
  return turn === 90 || turn === 270;
}

export function turnedSize(size: TurnSize, turn: QuarterTurn): TurnSize {
  return isSideways(turn)
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

// Canvas matrix that turns a picture drawn at the origin clockwise by `turn`,
// so it fills an output of `output` size. setTransform(a, b, c, d, e, f) maps
// (x, y) to (a·x + c·y + e, b·x + d·y + f).
export function turnMatrix(turn: QuarterTurn, output: TurnSize): [number, number, number, number, number, number] {
  if (turn === 90) return [0, 1, -1, 0, output.width, 0];
  if (turn === 180) return [-1, 0, 0, -1, output.width, output.height];
  if (turn === 270) return [0, -1, 1, 0, 0, output.height];
  return [1, 0, 0, 1, 0, 0];
}

interface TurnContext {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  drawImage(...args: unknown[]): void;
}

// Draws `region` of `source` into an output of `output` size, turned
// clockwise by `turn`. For 90 and 270 the output is the region's shape turned
// on its side. Turn 0 is the plain eight-argument drawImage it always was.
export function drawTurned(
  context: TurnContext,
  source: unknown,
  region: TurnRect,
  turn: QuarterTurn,
  output: TurnSize,
): void {
  if (turn === 0) {
    context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, output.width, output.height);
    return;
  }
  const upright = turnedSize(output, turn);
  context.setTransform(...turnMatrix(turn, output));
  context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, upright.width, upright.height);
  context.setTransform(1, 0, 0, 1, 0, 0);
}

// A rectangle in the turned (upright) picture, in fractions of its size,
// mapped back onto the untouched camera frame, also in fractions.
export function rectToFrame(
  rect: { left: number; top: number; width: number; height: number },
  turn: QuarterTurn,
): { left: number; top: number; width: number; height: number } {
  const { left, top, width, height } = rect;
  if (turn === 90) return { left: top, top: 1 - left - width, width: height, height: width };
  if (turn === 270) return { left: 1 - top - height, top: left, width: height, height: width };
  if (turn === 180) return { left: 1 - left - width, top: 1 - top - height, width, height };
  return { left, top, width, height };
}

// How far to turn the on-screen messages so they read upright for the people
// in front of the camera: the same way those people appear turned in the
// preview. The front camera's preview is mirrored, which reverses the turn.
export function messageTurn(turn: QuarterTurn, mirrored: boolean): QuarterTurn {
  if (turn === 0) return 0;
  return (mirrored ? turn : (360 - turn) % 360) as QuarterTurn;
}

// ---- Reading how upright the people in a frame are ----

interface TurnKeypoint {
  name?: string;
  score?: number;
  x?: number;
  y?: number;
}

export const UPRIGHT_MIN_SCORE = 0.35;

// Steepest lean, as horizontal over vertical (about 40 degrees), at which a
// body still counts as standing.
const MAX_LEAN = 0.84;

type Point = { x: number; y: number };

function centre(points: TurnKeypoint[]): Point | null {
  if (!points.length) return null;
  return {
    x: points.reduce((sum, point) => sum + (point.x as number), 0) / points.length,
    y: points.reduce((sum, point) => sum + (point.y as number), 0) / points.length,
  };
}

// An upright face: both eyes level with each other and above the nose.
function faceUpright(find: (name: string) => TurnKeypoint | undefined): boolean {
  const leftEye = find('left_eye');
  const rightEye = find('right_eye');
  const nose = find('nose');
  if (!leftEye || !rightEye || !nose) return false;
  const across = Math.abs((leftEye.x as number) - (rightEye.x as number));
  const tilt = Math.abs((leftEye.y as number) - (rightEye.y as number));
  const eyeY = ((leftEye.y as number) + (rightEye.y as number)) / 2;
  return across > 0 && tilt < across * 0.7 && eyeY < (nose.y as number);
}

// An upright body: shoulders above hips above knees above ankles, for as
// many of those as were found, and standing rather than lying.
function bodyUpright(find: (name: string) => TurnKeypoint | undefined): boolean {
  const level = (side: string) => centre(
    [find(`left_${side}`), find(`right_${side}`)].filter((point): point is TurnKeypoint => Boolean(point)),
  );
  const levels = ['shoulder', 'hip', 'knee', 'ankle'].map(level);
  if (!levels[0]) return false;
  const found = levels.filter((point): point is Point => point !== null);
  if (found.length < 2) return false;
  for (let index = 1; index < found.length; index += 1) {
    if (found[index].y <= found[index - 1].y) return false;
  }
  const top = found[0];
  const bottom = found[found.length - 1];
  return Math.abs(bottom.x - top.x) <= MAX_LEAN * (bottom.y - top.y);
}

// The number of confidently found body points on people who stand upright in
// the frame, judged by an upright face or an upright body. People lying on
// their side, upside down, or the detector's guesses at them count for nothing.
export function uprightScore(poses: { keypoints: TurnKeypoint[] }[] | undefined, minScore = UPRIGHT_MIN_SCORE): number {
  let total = 0;
  for (const pose of poses || []) {
    const points = (pose?.keypoints || []).filter((point) => (
      (point.score ?? 0) >= minScore && Number.isFinite(point.x) && Number.isFinite(point.y)
    ));
    const find = (name: string) => points.find((point) => point.name === name);
    if (!faceUpright(find) && !bodyUpright(find)) continue;
    total += Math.min(17, points.length);
  }
  return total;
}

// ---- Deciding the turn ----

export const UPRIGHT_ENOUGH = 8;
export const PROBE_AFTER_WEAK = 2;
export const PROBE_MARGIN = 4;
export const SWITCH_AFTER_HITS = 2;

export interface TurnTracker {
  turn: QuarterTurn;
  weak: number;
  next: number;
  candidate: QuarterTurn | null;
  hits: number;
  onChange?: (turn: QuarterTurn) => void;
}

export function createTurnTracker(turn: QuarterTurn = 0, onChange?: (turn: QuarterTurn) => void): TurnTracker {
  return { turn, weak: 0, next: 0, candidate: null, hits: 0, onChange };
}

function alternatives(turn: QuarterTurn): QuarterTurn[] {
  return [90, 270, 180].map((step) => ((turn + step) % 360) as QuarterTurn);
}

// After reading the frame at the current turn: which other turn, if any, to
// try on this frame as well. Nothing is tried while upright people are seen,
// and while nobody is, only every other frame, to keep the tablet cool.
export function planProbe(tracker: TurnTracker, currentScore: number): QuarterTurn | null {
  if (currentScore >= UPRIGHT_ENOUGH) {
    tracker.weak = 0;
    tracker.candidate = null;
    tracker.hits = 0;
    return null;
  }
  tracker.weak += 1;
  if (tracker.weak < PROBE_AFTER_WEAK || (tracker.weak - PROBE_AFTER_WEAK) % 2 !== 0) return null;
  if (tracker.candidate !== null) return tracker.candidate;
  const options = alternatives(tracker.turn);
  const probe = options[tracker.next % options.length];
  tracker.next += 1;
  return probe;
}

// Records how the tried turn did. Returns true when the tracker switched to it.
export function recordProbe(tracker: TurnTracker, probe: QuarterTurn, probeScore: number, currentScore: number): boolean {
  const better = probeScore >= UPRIGHT_ENOUGH && probeScore >= currentScore + PROBE_MARGIN;
  if (!better) {
    if (tracker.candidate === probe) {
      tracker.candidate = null;
      tracker.hits = 0;
    }
    return false;
  }
  tracker.hits = tracker.candidate === probe ? tracker.hits + 1 : 1;
  tracker.candidate = probe;
  if (tracker.hits < SWITCH_AFTER_HITS) return false;
  setTurn(tracker, probe);
  return true;
}

export function setTurn(tracker: TurnTracker, turn: QuarterTurn): void {
  const changed = tracker.turn !== turn;
  tracker.turn = turn;
  tracker.weak = 0;
  tracker.next = 0;
  tracker.candidate = null;
  tracker.hits = 0;
  if (changed) tracker.onChange?.(turn);
}

// Reads a frame at the current turn and, when nobody upright is found, at one
// other turn too. A turn that keeps showing upright people is adopted, and
// the reading it gave is used straight away.
export async function readWithTurn<R extends { upright?: number }>(
  tracker: TurnTracker,
  read: (turn: QuarterTurn) => Promise<R>,
): Promise<{ reading: R; turn: QuarterTurn; switched: boolean }> {
  const turn = tracker.turn;
  const reading = await read(turn);
  const score = reading.upright ?? 0;
  const probe = planProbe(tracker, score);
  if (probe === null) return { reading, turn, switched: false };
  const trial = await read(probe);
  if (recordProbe(tracker, probe, trial.upright ?? 0, score)) return { reading: trial, turn: probe, switched: true };
  return { reading, turn, switched: false };
}

// ---- One tracker per camera, remembered across reloads ----

const STORAGE_PREFIX = 'facultytrack:camera-turn:';
const trackers = new Map<string, TurnTracker>();

function storedTurn(key: string): QuarterTurn {
  try {
    const value = Number(globalThis.localStorage?.getItem(STORAGE_PREFIX + key));
    return ([0, 90, 180, 270] as number[]).includes(value) ? value as QuarterTurn : 0;
  } catch {
    return 0;
  }
}

function storeTurn(key: string, turn: QuarterTurn): void {
  try {
    if (turn === 0) globalThis.localStorage?.removeItem(STORAGE_PREFIX + key);
    else globalThis.localStorage?.setItem(STORAGE_PREFIX + key, String(turn));
  } catch {
  }
}

// The same camera keeps its turn when the screen switches between one person
// and a group, and after a reload, so a tablet that is always held sideways
// starts out right.
export function sharedTurnTracker(camera: string): TurnTracker {
  let tracker = trackers.get(camera);
  if (!tracker) {
    tracker = createTurnTracker(storedTurn(camera), (turn) => storeTurn(camera, turn));
    trackers.set(camera, tracker);
  }
  return tracker;
}
