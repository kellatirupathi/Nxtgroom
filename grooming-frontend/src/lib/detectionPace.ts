// How often the camera looks at the picture.
//
// A full reading (is the body whole, is everybody facing the camera) is taken
// on the same beat as it always was, so nothing about when a photograph fires
// changes. What changed is the time in between: while somebody is in view the
// camera uses it for extra quick looks that only move the face boxes, so a
// box keeps up with the person instead of trailing a third of a second
// behind. With nobody in view there are no extra looks, and the tablet works
// no harder than before.

// The pause after one full reading before the next is started.
export const DECISION_INTERVAL_MS = 200;

// Between quick looks the tablet rests for about half the time a look takes.
export const FOLLOW_MIN_GAP_MS = 20;
export const FOLLOW_MAX_GAP_MS = 60;

export interface ReadPlan {
  delayMs: number;
  quick: boolean;
}

export function followGap(readCostMs: number): number {
  const cost = Number.isFinite(readCostMs) && readCostMs > 0 ? readCostMs : 0;
  return Math.max(FOLLOW_MIN_GAP_MS, Math.min(FOLLOW_MAX_GAP_MS, cost * 0.5));
}

// What to do next: a quick look if one fits before the next full reading is
// due, otherwise wait for that reading. A full reading is never pushed back.
export function planNextRead(
  { sinceDecisionMs, readCostMs, personInView }: { sinceDecisionMs: number; readCostMs: number; personInView: boolean },
): ReadPlan {
  const untilDecision = Math.max(0, DECISION_INTERVAL_MS - Math.max(0, sinceDecisionMs));
  if (!personInView) return { delayMs: untilDecision, quick: false };
  const gap = followGap(readCostMs);
  const cost = Number.isFinite(readCostMs) && readCostMs > 0 ? readCostMs : 0;
  return gap + cost <= untilDecision
    ? { delayMs: gap, quick: true }
    : { delayMs: untilDecision, quick: false };
}

// A running estimate of how long one look at the picture takes.
export function smoothedCost(previous: number, latest: number): number {
  if (!(latest >= 0) || !Number.isFinite(latest)) return previous;
  return previous > 0 ? previous * 0.7 + latest * 0.3 : latest;
}
