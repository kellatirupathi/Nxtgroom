// Whether the people in front of the camera are standing still.
//
// A photograph of somebody who is still stepping into place comes out
// smeared, however sharp the camera is. Each reading of the picture leaves an
// anchor per person (a few body points and the person's height), and two
// readings a moment apart show how fast each person is moving, in body
// heights per second. The camera waits for that to settle before it fires,
// but never for long: the photograph is then the sharpest of several frames.

export interface Anchor {
  id?: number;
  x: number;
  y: number;
  size: number;
  points: Record<string, readonly [number, number]>;
}

export interface SteadyMemory {
  samples: { at: number; anchors: Anchor[] }[];
}

// Two readings closer together than this differ mostly by detector noise.
export const STEADY_BASELINE_MS = 350;
export const STEADY_HISTORY_MS = 1_200;

// Body heights per second. Somebody walking moves several times faster;
// somebody standing still reads well under this.
export const MAX_BODY_SPEED = 0.15;
export const MAX_GROUP_BODY_SPEED = 0.2;

// The longest a ready photograph is held back for people to settle.
export const STEADY_WAIT_LIMIT_MS = 1_500;

export const ANCHOR_POINTS: readonly string[] = [
  'nose',
  'left_shoulder',
  'right_shoulder',
  'left_hip',
  'right_hip',
];

interface AnchorKeypoint {
  name?: string;
  score?: number;
  x?: number;
  y?: number;
}

// The anchor of one person, in fractions of the frame height on both axes so
// that a distance means the same whichever way it points.
export function anchorFromPose(
  pose: { keypoints: AnchorKeypoint[]; id?: number },
  frameHeight: number,
  minScore = 0.35,
): Anchor | null {
  if (!(frameHeight > 0)) return null;
  const seen = (pose?.keypoints || []).filter((point) => (
    (point.score ?? 0) >= minScore && Number.isFinite(point.x) && Number.isFinite(point.y)
  ));
  if (seen.length < 3) return null;
  const xs = seen.map((point) => (point.x as number) / frameHeight);
  const ys = seen.map((point) => (point.y as number) / frameHeight);
  const points: Record<string, readonly [number, number]> = {};
  for (const point of seen) {
    if (point.name && ANCHOR_POINTS.includes(point.name)) {
      points[point.name] = [(point.x as number) / frameHeight, (point.y as number) / frameHeight];
    }
  }
  return {
    ...(typeof pose.id === 'number' ? { id: pose.id } : {}),
    x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
    y: ys.reduce((sum, value) => sum + value, 0) / ys.length,
    size: Math.max(0.05, Math.max(...ys) - Math.min(...ys)),
    points,
  };
}

export function createSteadyMemory(): SteadyMemory {
  return { samples: [] };
}

export function forgetAnchors(memory: SteadyMemory): void {
  memory.samples = [];
}

export function recordAnchors(memory: SteadyMemory, anchors: Anchor[] | undefined, now: number): void {
  memory.samples = memory.samples.filter((sample) => now - sample.at <= STEADY_HISTORY_MS && sample.at <= now);
  memory.samples.push({ at: now, anchors: anchors || [] });
}

export const SAME_BODY_WITHIN = 0.15;

function sameBody(anchor: Anchor, candidates: Anchor[]): Anchor | null {
  if (anchor.id !== undefined) {
    const tracked = candidates.find((candidate) => candidate.id === anchor.id);
    if (tracked) return tracked;
  }
  let nearest: Anchor | null = null;
  let nearestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.x - anchor.x, candidate.y - anchor.y);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  // People in a group stand about a quarter of their height apart, so anybody
  // found further away than this is a neighbour, not the same person.
  return nearest && nearestDistance <= anchor.size * SAME_BODY_WITHIN ? nearest : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function movementSince(
  reference: SteadyMemory['samples'][number],
  anchors: Anchor[],
  now: number,
): number | null {
  const seconds = (now - reference.at) / 1000;
  let fastest = 0;
  for (const anchor of anchors) {
    const earlier = sameBody(anchor, reference.anchors);
    if (!earlier) return null;
    const moved: number[] = [];
    for (const [name, [x, y]] of Object.entries(anchor.points)) {
      const before = earlier.points[name];
      if (before) moved.push(Math.hypot(x - before[0], y - before[1]));
    }
    if (moved.length < 2) return null;
    fastest = Math.max(fastest, median(moved) / anchor.size / seconds);
  }
  return fastest;
}

// The fastest anybody in `anchors` is moving, in body heights per second,
// against the newest earlier reading that is old enough to compare with and
// has everybody in it. The detector now and then misses a person for one
// look, so an earlier reading without somebody is passed over for an older
// one. Null while nothing can be told yet: nobody there, no earlier reading,
// or somebody who has only just appeared.
export function fastestMovement(memory: SteadyMemory, anchors: Anchor[] | undefined, now: number): number | null {
  if (!anchors?.length) return null;
  const earlier = memory.samples
    .filter((sample) => {
      const age = now - sample.at;
      return age >= STEADY_BASELINE_MS && age <= STEADY_HISTORY_MS;
    })
    .sort((a, b) => b.at - a.at);
  for (const reference of earlier) {
    const speed = movementSince(reference, anchors, now);
    if (speed !== null) return speed;
  }
  return null;
}

export function isSteady(
  memory: SteadyMemory,
  anchors: Anchor[] | undefined,
  now: number,
  limit = MAX_BODY_SPEED,
): boolean {
  const speed = fastestMovement(memory, anchors, now);
  return speed !== null && speed <= limit;
}

export interface SteadyHold {
  since: number | null;
}

// Whether a photograph that is otherwise ready may be taken now. It is held
// while people are still moving, for at most STEADY_WAIT_LIMIT_MS, so the
// camera can never be left waiting on a detector that will not settle.
export function clearToFire(hold: SteadyHold, ready: boolean, steady: boolean, now: number): boolean {
  if (!ready) {
    hold.since = null;
    return false;
  }
  if (steady) {
    hold.since = null;
    return true;
  }
  hold.since ??= now;
  if (now - hold.since < STEADY_WAIT_LIMIT_MS) return false;
  hold.since = null;
  return true;
}
