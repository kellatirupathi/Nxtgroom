import sharp from "sharp";
import { runtimeConfig } from "../config/env.js";
import {
  detectFacesForGroup,
  FACE_REASONS,
  isFaceRecognitionConfigured,
  searchFaceByImage,
} from "./faceRecognition.js";
import {
  bodyCoverage,
  faceSearchCrop,
  personBodyCrop,
  sortFacesForDisplay,
} from "./groupPhotoGeometry.js";
import { incrementMetric, observeDuration } from "./telemetry.js";

/**
 * Who is in a photograph of several people, and where each of their bodies is.
 *
 * The single-person route asks Rekognition one question about one photograph.
 * That API answers about the largest face it can find and ignores every other
 * one, so the same call on a group identifies whoever stood closest and quietly
 * drops the rest. This module exists because "quietly drops the rest" is not an
 * acceptable way to take five people's attendance.
 *
 * The shape is therefore: detect every face once, cut each one out, and ask the
 * same question five times. Nothing here is a new kind of matching — each
 * search is the identical call, against the identical collection, at the
 * identical threshold the single-person flow uses. Only the framing changed.
 *
 * Nothing in this module writes to the database or to storage. It reports who
 * was seen and hands back the bytes for each person; deciding what that means
 * for somebody's day stays with the route, where it already lives.
 */

export const GROUP_OUTCOMES = Object.freeze({
  /** Identified, above the accept threshold, and the only face that matched them. */
  MATCHED: "MATCHED",
  /** A usable face that nobody in the collection matched. */
  NO_MATCH: "NO_MATCH",
  /** Too few pixels to ask the question honestly. Not searched for. */
  TOO_SMALL: "TOO_SMALL",
  /**
   * A second face in the same photograph resolved to somebody already matched.
   * One of the two is a mistake and there is no way to tell which, so neither
   * is trusted with the better score's identity.
   */
  AMBIGUOUS: "AMBIGUOUS",
  /** Rekognition could not be reached for this face. */
  PROVIDER_ERROR: "PROVIDER_ERROR",
});

/**
 * Runs work in bounded parallel.
 *
 * The searches are network-bound and want to overlap; the crops hold
 * uncompressed pixels and must not. One helper for both, with the limit chosen
 * by the caller.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Rekognition refuses image bytes over 5MB. A detailed group photograph at
 * full size can approach that, so anything over this margin is detected at
 * the single-person size instead. The boxes come back as ratios, so they apply
 * to the full-size pixels either way.
 */
const DETECTION_MAX_BYTES = Math.floor(4.5 * 1024 * 1024);
const DETECTION_FALLBACK_DIMENSION = 2048;

/**
 * Pixels, whatever arrived.
 *
 * The route hands over pixels already decoded by normalizeGroupImage. An
 * encoded image is still accepted, and decoded once here, so the tests and any
 * other caller need not know about the difference.
 */
async function toPixels(input) {
  if (input?.data && input.width > 0 && input.height > 0 && input.channels > 0) return input;
  const { data, info } = await sharp(input, { animated: false, failOn: "warning" })
    .rotate()
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** A sharp pipeline over pixels already in memory: nothing is decoded again. */
function fromPixels(pixels) {
  return sharp(pixels.data, {
    raw: { width: pixels.width, height: pixels.height, channels: pixels.channels },
  });
}

/**
 * The image Rekognition is asked to find faces in: the whole photograph, at
 * the full resolution that was kept, so a face at the back is as findable as
 * the pixels allow.
 */
async function detectionImage(pixels) {
  const full = await fromPixels(pixels)
    .jpeg({ quality: 85, optimiseCoding: true })
    .toBuffer();
  if (full.length <= DETECTION_MAX_BYTES) return full;
  incrementMetric("group_detection_downscaled_total");
  return fromPixels(pixels)
    .resize({
      width: DETECTION_FALLBACK_DIMENSION,
      height: DETECTION_FALLBACK_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85, optimiseCoding: true })
    .toBuffer();
}

/**
 * Cuts one rectangle out of the photograph and encodes it on its own.
 *
 * Cut from pixels decoded once, rather than from an encoded image decoded
 * again for every crop: that repeated decode, and the slower mozjpeg encoder,
 * were most of what a group photograph cost before. The standard encoder at a
 * slightly higher quality gives an image at least as good, one generation of
 * compression fresher, at a few percent more bytes.
 *
 * No minimum size is enforced here. A crop is legitimately smaller than a
 * photograph, and a person standing at the back genuinely does occupy fewer
 * pixels — that is a fact about the photograph to be recorded, not an error to
 * raise.
 */
export async function cropRegion(pixels, rect, { quality = 88 } = {}) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const source = await toPixels(pixels);
  const left = Math.max(0, Math.round(rect.left));
  const top = Math.max(0, Math.round(rect.top));
  const { data, info } = await fromPixels(source)
    .extract({
      left,
      top,
      width: Math.max(1, Math.min(source.width - left, Math.round(rect.width))),
      height: Math.max(1, Math.min(source.height - top, Math.round(rect.height))),
    })
    .jpeg({ quality, chromaSubsampling: "4:4:4", optimiseCoding: true })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, mimeType: "image/jpeg", width: info.width, height: info.height };
}

/**
 * One face is only worth searching for if there is enough of it to search.
 *
 * Below the floor the crop is upscaled noise, and Rekognition will either
 * refuse it or — worse — return a confident match against somebody who happens
 * to share a few blurred features. A person told "stand closer" can act on
 * that; a person filed under a colleague's name cannot.
 */
function faceIsLargeEnough(box, imageWidth, imageHeight) {
  const minimum = runtimeConfig().groupMinFacePixels;
  return box.width * imageWidth >= minimum && box.height * imageHeight >= minimum;
}

/**
 * Identifies everybody in one photograph.
 *
 * Returns one entry per detected face, in reading order, each carrying the
 * identity if there is one and the body crop to analyse either way. An
 * unmatched person still gets their bytes back, because an unidentified record
 * is still a record of somebody who turned up and an administrator names it
 * later — exactly as the single-person route already does.
 */
export async function identifyPeopleInPhoto(input, _dimensions = {}) {
  if (!isFaceRecognitionConfigured()) {
    return { ok: false, reason: FACE_REASONS.NOT_CONFIGURED };
  }
  let pixels;
  try {
    pixels = await toPixels(input);
  } catch {
    return { ok: false, reason: FACE_REASONS.NO_FACE };
  }
  // Measured from the pixels themselves, never from a caller's say-so: every
  // crop rectangle below is computed from these, and a mismatch would cut the
  // wrong part of the photograph or run off its edge.
  const { width, height } = pixels;
  if (!(width > 0) || !(height > 0)) {
    return { ok: false, reason: FACE_REASONS.NO_FACE };
  }

  const config = runtimeConfig();
  const startedAt = Date.now();
  const detection = await detectFacesForGroup(await detectionImage(pixels), {
    maxFaces: config.groupMaxPeople,
  });
  if (!detection.ok) {
    return { ok: false, reason: detection.reason, message: detection.message, detected: detection.detected };
  }

  const faces = sortFacesForDisplay(detection.faces);

  /**
   * Each face is cut out and searched for on its own.
   *
   * Sequential cropping, overlapped searching: the crops are small and cheap
   * but hold pixels, while the searches are a round trip to Mumbai each and
   * would otherwise add up to seconds of somebody standing and waiting.
   */
  const searchCrops = await mapWithConcurrency(faces, config.groupCropConcurrency, async (face) => {
    if (!faceIsLargeEnough(face.box, width, height)) return null;
    try {
      // Not stored, only searched: a little more quality buys Rekognition a
      // little more detail at no cost to anybody's storage.
      return await cropRegion(pixels, faceSearchCrop(face.box, width, height), { quality: 92 });
    } catch {
      return null;
    }
  });

  const searches = await Promise.all(searchCrops.map(async (crop) => {
    if (!crop) return null;
    return searchFaceByImage(crop.buffer);
  }));

  const people = faces.map((face, index) => {
    const crop = searchCrops[index];
    if (!crop) {
      return { face, outcome: GROUP_OUTCOMES.TOO_SMALL, match: null, instructorId: null };
    }
    const match = searches[index];
    if (match?.ok) {
      return {
        face,
        outcome: GROUP_OUTCOMES.MATCHED,
        match,
        instructorId: String(match.instructorId),
      };
    }
    const outcome = match?.reason === FACE_REASONS.PROVIDER_ERROR
      ? GROUP_OUTCOMES.PROVIDER_ERROR
      : GROUP_OUTCOMES.NO_MATCH;
    return { face, outcome, match: match || null, instructorId: null };
  });

  /**
   * One person cannot be standing in two places.
   *
   * Two faces resolving to the same instructor means one of them is wrong, and
   * the scores do not say which — a look-alike above the threshold scores like
   * a genuine match. Taking the higher and recording it would file a stranger's
   * grooming under a real name half the time, so both are demoted and both
   * become records an administrator resolves by looking at the photographs.
   *
   * The daily unique index would refuse the second write anyway. This is not
   * that: the index protects the data, and this protects the person whose name
   * would otherwise be on the wrong one of the two.
   */
  const seenBy = new Map();
  for (const person of people) {
    if (person.outcome !== GROUP_OUTCOMES.MATCHED) continue;
    const existing = seenBy.get(person.instructorId);
    if (existing) {
      existing.outcome = GROUP_OUTCOMES.AMBIGUOUS;
      person.outcome = GROUP_OUTCOMES.AMBIGUOUS;
      incrementMetric("group_ambiguous_match_total");
      continue;
    }
    seenBy.set(person.instructorId, person);
  }

  /** The body crops, made only now so a refused face never costs one. */
  const bodies = await mapWithConcurrency(people, config.groupCropConcurrency, async (person) => {
    try {
      return await cropRegion(pixels, personBodyCrop(person.face.box, width, height));
    } catch {
      return null;
    }
  });

  observeDuration("group_identify_latency", Date.now() - startedAt);
  incrementMetric("group_identify_total");

  return {
    ok: true,
    detected: detection.detected,
    people: people.map((person, index) => ({
      index,
      outcome: person.outcome,
      // Only a person still MATCHED after the ambiguity sweep carries a name.
      instructorId: person.outcome === GROUP_OUTCOMES.MATCHED ? person.instructorId : null,
      similarity: person.outcome === GROUP_OUTCOMES.MATCHED ? person.match.similarity : null,
      faceId: person.outcome === GROUP_OUTCOMES.MATCHED ? person.match.faceId : null,
      runnerUp: person.outcome === GROUP_OUTCOMES.MATCHED ? person.match.runnerUp : null,
      box: person.face.box,
      quality: {
        confidence: person.face.confidence,
        sharpness: person.face.sharpness,
        brightness: person.face.brightness,
      },
      // What fraction of this person the crop actually contains. A report that
      // says nothing about footwear should be traceable to a crop that stopped
      // at the waist rather than to an analysis that went wrong.
      bodyCoverage: bodyCoverage(person.face.box, width, height),
      image: bodies[index],
    })),
  };
}

/** Wording for an outcome nobody was recorded under, shown at the tablet. */
export function describeGroupOutcome(outcome) {
  switch (outcome) {
    case GROUP_OUTCOMES.TOO_SMALL:
      return "Too far from the camera to identify";
    case GROUP_OUTCOMES.AMBIGUOUS:
      return "Two faces matched the same person, so neither was recorded by name";
    case GROUP_OUTCOMES.PROVIDER_ERROR:
      return "Face recognition could not be reached for this person";
    default:
      return "Not recognised";
  }
}
