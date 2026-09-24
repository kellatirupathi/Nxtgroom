/**
 * Decides whether a live camera frame shows a group worth photographing.
 *
 * The single-person gate next door asks a different question and keeps asking
 * it: one person, head to feet, filling most of the outline. Every rule it
 * applies is wrong here. Several people cannot each fill the frame, a group
 * standing shoulder to shoulder hides most of everybody's legs, and the verdict
 * that gate returns for this situation — MULTIPLE_PEOPLE — is a refusal.
 *
 * So this is a second gate rather than a setting on the first, and it is
 * deliberately looser. What it insists on is the one thing the whole feature
 * depends on: enough faces, pointed at the camera, to identify people by. How
 * much of each person's shirt the photograph caught is something the server
 * reports per person afterwards, because it is a fact about the result rather
 * than a reason to refuse to take the picture.
 *
 * Looser on purpose, and from experience. A strict framing rule that no real
 * tablet mounting could satisfy has already shipped here once, and a camera
 * that never fires is worse than one that fires on an imperfect frame: the
 * imperfect frame produces a record somebody can correct, and the refusal
 * produces a queue of people waiting in front of a screen telling them to move.
 */

import {
  duplicatePose,
  HEAD_KEYPOINTS,
  isDetectedPerson,
  KEYPOINT_CONFIDENCE,
  measureFrameQuality,
  MIN_FRAME_BRIGHTNESS,
  MIN_FRAME_SHARPNESS,
  type Detector,
  type Pose,
} from './fullBodyDetector.ts';
import { coverSourceRect } from './cameraGeometry.ts';
import { faceBoxesFromPoses, type BoxPose, type FaceBox } from './faceBoxes.ts';
import { assessBody, shortBodyProblem } from './bodyCompleteness.ts';

export type GroupVerdict =
  /** Enough faces, all pointed this way. The camera may fire. */
  | 'GROUP_READY'
  /** Somebody is not in the frame from head to feet. */
  | 'BODIES_CUT'
  /** People are there, but not all of them are facing the camera. */
  | 'FACES_HIDDEN'
  /** One person. That is what the single-person screen is for. */
  | 'TOO_FEW'
  /** More people than one request may record. */
  | 'TOO_MANY'
  | 'NO_PEOPLE'
  | 'UNAVAILABLE';

export interface GroupReading {
  verdict: GroupVerdict;
  guidance: string | null;
  /** Distinct people the detector is confident about. */
  people: number;
  /** How many of them are showing a face the camera could identify. */
  faces: number;
  /**
   * Where each of those faces is, for drawing a box on the preview.
   *
   * Shown to the people in front of the camera and used for nothing else. It is
   * what turns "2 people are not facing the camera" into something actionable:
   * without it a group of six is told a number and left to work out which two
   * of them it means.
   */
  boxes?: FaceBox[];
}

/**
 * The most people one photograph may contain.
 *
 * Matches GROUP_ATTENDANCE_MAX_PEOPLE on the server, which is what actually
 * enforces it — this copy exists so the tablet can say "too many" while people
 * are still arranging themselves, rather than after a round trip that refuses
 * the photograph. If the two ever disagree the server wins and the tablet shows
 * its refusal, which is the right way round.
 */
export const GROUP_MAX_PEOPLE = 6;

/** Below two people this is not a group, and the single-person screen is better. */
export const GROUP_MIN_PEOPLE = 2;

/**
 * Readings of the same good frame before the camera fires itself.
 *
 * A little longer than the single-person hold. Six people settle more slowly
 * than one, and the difference between a group still arranging itself and a
 * group standing still is a few hundred milliseconds of agreement.
 */
export const GROUP_CAPTURE_CONFIRMATIONS = 4;

/**
 * Consecutive unusable readings before the manual shutter is offered.
 *
 * Lower than the single-person count. Group framing has more ways to be
 * imperfect and somebody is always looking the wrong way, so the button that
 * lets a person judge the frame themselves should appear sooner.
 */
export const GROUP_FALLBACK_ATTEMPTS = 15;

/** Whether this pose is showing a face the camera could identify somebody from. */
export function faceIsVisible(pose: Pose): boolean {
  const seen = pose.keypoints.filter((point) => (
    point.name != null
    && HEAD_KEYPOINTS.includes(point.name)
    && (point.score ?? 0) >= KEYPOINT_CONFIDENCE
  ));
  // Two of nose, left eye and right eye. One alone is as likely to be a profile
  // or the back of a head, which Rekognition cannot match against a reference
  // photograph taken face-on.
  return seen.length >= 2;
}

/**
 * The distinct people in a frame.
 *
 * MoveNet emits overlapping copies of one person often enough that counting
 * raw poses would report a group of two where one person is standing. The same
 * two rules the single-person gate uses decide what counts, so the two screens
 * never disagree about how many people are present.
 */
export function distinctPeople(poses: Pose[] | undefined, frameHeight?: number): Pose[] {
  const people: Pose[] = [];
  const candidates = (poses || [])
    .filter(isDetectedPerson)
    .sort((a, b) => (
      b.keypoints.filter((point) => (point.score ?? 0) >= KEYPOINT_CONFIDENCE).length
      - a.keypoints.filter((point) => (point.score ?? 0) >= KEYPOINT_CONFIDENCE).length
    ));
  for (const candidate of candidates) {
    if (!people.some((person) => duplicatePose(person, candidate, frameHeight))) {
      people.push(candidate);
    }
  }
  return people;
}

/** Whether one person in the group is in frame from head to feet. */
function bodyIsWhole(pose: Pose, frameHeight?: number): boolean {
  return assessBody(pose.keypoints, { frameHeight, minScore: KEYPOINT_CONFIDENCE }).complete;
}

/**
 * The chip under one person's box: what they, specifically, need to fix.
 *
 * The guidance line says how many people have a problem; this says which.
 * A hidden face comes first because without one there is nobody to identify,
 * whatever the rest of the body is doing.
 */
export function boxLabel(pose: BoxPose, frameHeight?: number): string | null {
  if (!faceIsVisible(pose)) return 'Face the camera';
  const body = assessBody(pose.keypoints, { frameHeight, minScore: KEYPOINT_CONFIDENCE });
  return shortBodyProblem(body.problem);
}

/**
 * The boxes for a group: one per counted person, carrying that person's chip.
 *
 * Built from the same distinct people the verdict counts, never from the raw
 * poses. MoveNet emits overlapping copies of one person, and the gate discards
 * them - but a box drawn on a discarded copy would carry a chip about somebody
 * the gate is not counting: "Step back" under a face the countdown is already
 * running for. The box list and the verdict have to be made from one list of
 * people, or the screen contradicts itself.
 */
export function groupBoxes(
  poses: Pose[] | undefined,
  { frameWidth, frameHeight, mirrored }: { frameWidth: number; frameHeight: number; mirrored?: boolean },
): FaceBox[] {
  return faceBoxesFromPoses(distinctPeople(poses, frameHeight), {
    frameWidth,
    frameHeight,
    mirrored,
    minScore: KEYPOINT_CONFIDENCE,
    labelFor: (pose) => boxLabel(pose, frameHeight),
  });
}

/** Turns the poses in one frame into a group capture decision. */
export function readGroupPoses(poses: Pose[] | undefined, frameHeight?: number): GroupReading {
  const people = distinctPeople(poses, frameHeight);
  const faces = people.filter(faceIsVisible).length;

  if (people.length === 0) {
    return { verdict: 'NO_PEOPLE', guidance: 'Step into the frame together', people: 0, faces: 0 };
  }
  if (people.length < GROUP_MIN_PEOPLE) {
    return {
      verdict: 'TOO_FEW',
      guidance: 'Only one person — use single check-in, or bring the others in',
      people: people.length,
      faces,
    };
  }
  if (people.length > GROUP_MAX_PEOPLE) {
    return {
      verdict: 'TOO_MANY',
      guidance: `Too many people — ${GROUP_MAX_PEOPLE} at a time`,
      people: people.length,
      faces,
    };
  }
  if (faces < people.length) {
    const hidden = people.length - faces;
    return {
      verdict: 'FACES_HIDDEN',
      guidance: hidden === 1
        ? 'One person is not facing the camera'
        : `${hidden} people are not facing the camera`,
      people: people.length,
      faces,
    };
  }
  /**
   * Everybody head to feet, or nobody is photographed.
   *
   * This is the rule the single-person camera has always applied, and a group
   * does not get a looser one: a person cut off at the waist gets a report with
   * nothing to say about their trousers or shoes, and six of those are six
   * reports to redo. The wording covers the other reason somebody can be half
   * in frame - they were walking past - because from here the two look alike.
   */
  const cut = people.filter((person) => !bodyIsWhole(person, frameHeight)).length;
  if (cut > 0) {
    return {
      verdict: 'BODIES_CUT',
      guidance: cut === 1
        ? 'One person is not fully in frame — step back, or step out if not checking in'
        : `${cut} people are not fully in frame — step back so everyone shows head to feet`,
      people: people.length,
      faces,
    };
  }
  return { verdict: 'GROUP_READY', guidance: null, people: people.length, faces };
}

export interface StableGroupState {
  reading: GroupReading;
  candidate: GroupReading | null;
  candidateCount: number;
}

export const INITIAL_GROUP_STATE: StableGroupState = {
  reading: { verdict: 'NO_PEOPLE', guidance: 'Step into the frame together', people: 0, faces: 0 },
  candidate: null,
  candidateCount: 0,
};

/**
 * Requires the same verdict several times before the screen changes.
 *
 * The count is part of the state rather than the verdict, so a group of four
 * that the detector momentarily reads as three does not reset the hold — the
 * verdict is what has to agree, and both readings say GROUP_READY.
 */
export function stabilizeGroupReading(
  state: StableGroupState,
  next: GroupReading,
  confirmations = 3,
): StableGroupState {
  if (next.verdict === state.reading.verdict) {
    return { reading: next, candidate: null, candidateCount: 0 };
  }
  const candidateCount = state.candidate?.verdict === next.verdict
    ? state.candidateCount + 1
    : 1;
  if (candidateCount >= confirmations) {
    return { reading: next, candidate: null, candidateCount: 0 };
  }
  return { reading: state.reading, candidate: next, candidateCount };
}

/** Whether the camera should photograph the group by itself. */
export function groupCaptureReady(verdict: GroupVerdict, steadyFrames: number): boolean {
  if (verdict !== 'GROUP_READY') return false;
  return steadyFrames >= GROUP_CAPTURE_CONFIRMATIONS;
}

/**
 * Whether the manual shutter should be enabled.
 *
 * Permissive, exactly as the single-person shutter is: somebody pressing the
 * button has looked at the frame and decided it is fine, and the server reports
 * per person what it could and could not do with the photograph. Only a frame
 * with nobody in it, or more people than one request may record, stays blocked.
 */
export function groupShutterEnabled(verdict: GroupVerdict): boolean {
  return verdict !== 'NO_PEOPLE' && verdict !== 'TOO_MANY';
}

/** Whether a run of unusable frames has gone on long enough to offer the button. */
export function groupFallbackDue(unusableFrames: number): boolean {
  return unusableFrames >= GROUP_FALLBACK_ATTEMPTS;
}

/**
 * Reads one frame for the group screen. Never throws.
 *
 * The analysed rectangle is the whole visible preview rather than the
 * single-person outline: a group occupies the full width of the frame, and
 * measuring them against a narrow standing guide would report everybody at the
 * edges as absent.
 */
export async function readGroupFrame(
  detector: Detector | null,
  video: HTMLVideoElement,
  viewport?: { width: number; height: number; canvas: HTMLCanvasElement },
  options?: { mirrored?: boolean },
): Promise<GroupReading> {
  if (!detector || !video.videoWidth) {
    return { verdict: 'UNAVAILABLE', guidance: null, people: 0, faces: 0 };
  }
  try {
    let input: HTMLVideoElement | HTMLCanvasElement = video;
    let frameHeight = video.videoHeight;
    if (viewport?.width && viewport.height) {
      const crop = coverSourceRect(video.videoWidth, video.videoHeight, viewport.width, viewport.height);
      const scale = Math.min(1, 480 / Math.max(crop.width, crop.height));
      const canvas = viewport.canvas;
      canvas.width = Math.max(1, Math.round(crop.width * scale));
      canvas.height = Math.max(1, Math.round(crop.height * scale));
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
        input = canvas;
        frameHeight = canvas.height;
      }
    }
    // Room for one more than the cap, so a seventh person is counted and
    // refused rather than silently not detected.
    const poses = await detector.estimatePoses(input, { maxPoses: GROUP_MAX_PEOPLE + 1 });
    // Every face, not just one: the point of the boxes here is to show a group
    // who the camera has and has not found.
    const boxes = groupBoxes(poses, {
      frameWidth: input instanceof HTMLCanvasElement ? input.width : video.videoWidth,
      frameHeight,
      mirrored: options?.mirrored,
    });
    const reading = readGroupPoses(poses, frameHeight);
    if (reading.verdict !== 'GROUP_READY' || !(input instanceof HTMLCanvasElement)) {
      return { ...reading, boxes };
    }

    // Exposure and blur matter more in a group than alone: each person occupies
    // a fraction of the frame, so a soft photograph leaves every one of their
    // faces below what Rekognition can match.
    const context = input.getContext('2d', { willReadFrequently: true });
    if (!context) return { ...reading, boxes };
    const quality = measureFrameQuality(
      context.getImageData(0, 0, input.width, input.height).data,
      input.width,
      input.height,
    );
    if (quality.brightness < MIN_FRAME_BRIGHTNESS) {
      return { ...reading, boxes, verdict: 'FACES_HIDDEN', guidance: 'Move to a brighter area' };
    }
    if (quality.sharpness < MIN_FRAME_SHARPNESS) {
      return { ...reading, boxes, verdict: 'FACES_HIDDEN', guidance: 'Everybody hold still' };
    }
    return { ...reading, boxes };
  } catch {
    return { verdict: 'UNAVAILABLE', guidance: null, people: 0, faces: 0 };
  }
}
