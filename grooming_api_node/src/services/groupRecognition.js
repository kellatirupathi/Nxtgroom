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

export const GROUP_OUTCOMES = Object.freeze({
  MATCHED: "MATCHED",
  NO_MATCH: "NO_MATCH",
  TOO_SMALL: "TOO_SMALL",
  AMBIGUOUS: "AMBIGUOUS",
  PROVIDER_ERROR: "PROVIDER_ERROR",
});

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

const DETECTION_MAX_BYTES = Math.floor(4.5 * 1024 * 1024);
const DETECTION_FALLBACK_DIMENSION = 2048;

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

function fromPixels(pixels) {
  return sharp(pixels.data, {
    raw: { width: pixels.width, height: pixels.height, channels: pixels.channels },
  });
}

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

function faceIsLargeEnough(box, imageWidth, imageHeight) {
  const minimum = runtimeConfig().groupMinFacePixels;
  return box.width * imageWidth >= minimum && box.height * imageHeight >= minimum;
}

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

  const searchCrops = await mapWithConcurrency(faces, config.groupCropConcurrency, async (face) => {
    if (!faceIsLargeEnough(face.box, width, height)) return null;
    try {
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
      bodyCoverage: bodyCoverage(person.face.box, width, height),
      image: bodies[index],
    })),
  };
}

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
