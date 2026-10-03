import {
  DeleteFacesCommand,
  DetectFacesCommand,
  IndexFacesCommand,
  RekognitionClient,
  SearchFacesByImageCommand,
} from "@aws-sdk/client-rekognition";
import { runtimeConfig } from "../config/env.js";
import { incrementMetric, observeDuration } from "./telemetry.js";

let client = null;
let clientFingerprint = "";

let clientOverride = null;

export function setRekognitionClientForTests(stub) {
  clientOverride = stub;
  client = null;
  clientFingerprint = "";
}

export function isFaceRecognitionConfigured() {
  const config = runtimeConfig();
  return Boolean(
    config.rekognitionCollectionId
    && config.rekognitionRegion
    && config.rekognitionAccessKeyId
    && config.rekognitionSecretAccessKey
  );
}

function getClient() {
  if (clientOverride) return clientOverride;
  const config = runtimeConfig();
  const fingerprint = `${config.rekognitionRegion}|${config.rekognitionAccessKeyId}`;
  if (!client || clientFingerprint !== fingerprint) {
    client = new RekognitionClient({
      region: config.rekognitionRegion,
      credentials: {
        accessKeyId: config.rekognitionAccessKeyId,
        secretAccessKey: config.rekognitionSecretAccessKey,
      },
      maxAttempts: config.rekognitionMaxAttempts,
      requestHandler: { requestTimeout: config.rekognitionTimeoutMs },
    });
    clientFingerprint = fingerprint;
  }
  return client;
}

export const FACE_REASONS = {
  NOT_CONFIGURED: "NOT_CONFIGURED",
  NO_FACE: "NO_FACE",
  MULTIPLE_FACES: "MULTIPLE_FACES",
  POOR_QUALITY: "POOR_QUALITY",
  NO_MATCH: "NO_MATCH",
  BELOW_THRESHOLD: "BELOW_THRESHOLD",
  PROVIDER_ERROR: "PROVIDER_ERROR",
};

export const FACE_REASON_MESSAGES = {
  NOT_CONFIGURED: "Face recognition is not configured on the server.",
  NO_FACE: "No face was found in this photograph. Use a clear, front-facing photo.",
  MULTIPLE_FACES: "More than one face was found. Use a photograph of only this instructor.",
  POOR_QUALITY: "The face is too blurry or too dark to use as a reference. Retake it in better light.",
  NO_MATCH: "No enrolled instructor matches this face.",
  BELOW_THRESHOLD: "The closest match was not confident enough to be used.",
  PROVIDER_ERROR: "The face recognition service could not be reached.",
};

function failure(reason) {
  return { ok: false, reason, message: FACE_REASON_MESSAGES[reason] };
}

function providerFailure(operation, error) {
  incrementMetric("rekognition_request_failures_total");
  console.error(`Rekognition ${operation} failed: ${error?.name || "Error"}`);
  return failure(FACE_REASONS.PROVIDER_ERROR);
}

async function send(operation, command) {
  const startedAt = Date.now();
  incrementMetric("rekognition_requests_total");
  try {
    const response = await getClient().send(command);
    observeDuration("rekognition_request_latency", Date.now() - startedAt);
    return { response };
  } catch (error) {
    observeDuration("rekognition_request_latency", Date.now() - startedAt);
    return { error };
  }
}

export async function checkFaceQuality(imageBuffer) {
  if (!isFaceRecognitionConfigured()) return failure(FACE_REASONS.NOT_CONFIGURED);
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return failure(FACE_REASONS.NO_FACE);
  }

  const { response, error } = await send(
    "DetectFaces",
    new DetectFacesCommand({
      Image: { Bytes: imageBuffer },
      Attributes: ["DEFAULT"],
    })
  );
  if (error) return providerFailure("DetectFaces", error);

  const faces = response?.FaceDetails || [];
  if (faces.length === 0) return failure(FACE_REASONS.NO_FACE);
  if (faces.length > 1) return failure(FACE_REASONS.MULTIPLE_FACES);

  const [face] = faces;
  const config = runtimeConfig();
  const sharpness = Number(face?.Quality?.Sharpness ?? 0);
  const brightness = Number(face?.Quality?.Brightness ?? 0);
  const confidence = Number(face?.Confidence ?? 0);
  if (
    confidence < config.rekognitionMinFaceConfidence
    || sharpness < config.rekognitionMinSharpness
    || brightness < config.rekognitionMinBrightness
  ) {
    return failure(FACE_REASONS.POOR_QUALITY);
  }

  return {
    ok: true,
    quality: { sharpness, brightness, confidence },
  };
}

export async function indexFace(imageBuffer, instructorId) {
  if (!isFaceRecognitionConfigured()) return failure(FACE_REASONS.NOT_CONFIGURED);
  const externalImageId = String(instructorId || "");
  if (!/^[A-Za-z0-9_.\-:]{1,255}$/.test(externalImageId)) {
    return failure(FACE_REASONS.NO_FACE);
  }

  const config = runtimeConfig();
  const { response, error } = await send(
    "IndexFaces",
    new IndexFacesCommand({
      CollectionId: config.rekognitionCollectionId,
      Image: { Bytes: imageBuffer },
      ExternalImageId: externalImageId,
      MaxFaces: 1,
      QualityFilter: "AUTO",
      DetectionAttributes: [],
    })
  );
  if (error) return providerFailure("IndexFaces", error);

  const faceId = response?.FaceRecords?.[0]?.Face?.FaceId;
  if (!faceId) {
    incrementMetric("rekognition_index_rejected_total");
    return failure(FACE_REASONS.POOR_QUALITY);
  }
  incrementMetric("rekognition_index_success_total");
  return { ok: true, faceId, instructorId: externalImageId };
}

export async function searchFaceByImage(imageBuffer) {
  if (!isFaceRecognitionConfigured()) return failure(FACE_REASONS.NOT_CONFIGURED);
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return failure(FACE_REASONS.NO_FACE);
  }

  const config = runtimeConfig();
  const { response, error } = await send(
    "SearchFacesByImage",
    new SearchFacesByImageCommand({
      CollectionId: config.rekognitionCollectionId,
      Image: { Bytes: imageBuffer },
      FaceMatchThreshold: config.rekognitionMatchThreshold,
      MaxFaces: config.rekognitionSearchCandidates,
      QualityFilter: "LOW",
    })
  );
  if (error) {
    if (error?.name === "InvalidParameterException") {
      incrementMetric("rekognition_search_no_face_total");
      return failure(FACE_REASONS.NO_FACE);
    }
    return providerFailure("SearchFacesByImage", error);
  }

  const matches = response?.FaceMatches || [];
  if (matches.length === 0) {
    incrementMetric("rekognition_search_no_match_total");
    return failure(FACE_REASONS.NO_MATCH);
  }

  const bestByPerson = new Map();
  for (const match of matches) {
    const personId = match?.Face?.ExternalImageId;
    const similarity = Number(match?.Similarity ?? 0);
    if (!personId || !Number.isFinite(similarity)) continue;
    const existing = bestByPerson.get(personId);
    if (!existing || similarity > existing.similarity) {
      bestByPerson.set(personId, { similarity, faceId: match?.Face?.FaceId || null });
    }
  }
  if (bestByPerson.size === 0) {
    incrementMetric("rekognition_search_unattributed_total");
    return failure(FACE_REASONS.NO_MATCH);
  }

  const ranked = [...bestByPerson.entries()]
    .map(([instructorId, value]) => ({ instructorId, ...value }))
    .sort((a, b) => b.similarity - a.similarity);
  const [best, runnerUp] = ranked;

  if (best.similarity < config.rekognitionMatchThreshold) {
    incrementMetric("rekognition_search_below_threshold_total");
    return failure(FACE_REASONS.BELOW_THRESHOLD);
  }

  incrementMetric("rekognition_search_match_total");
  return {
    ok: true,
    instructorId: best.instructorId,
    faceId: best.faceId,
    similarity: best.similarity,
    runnerUp: runnerUp
      ? { instructorId: runnerUp.instructorId, similarity: runnerUp.similarity }
      : null,
  };
}

export async function deleteFaces(faceIds) {
  if (!isFaceRecognitionConfigured()) return failure(FACE_REASONS.NOT_CONFIGURED);
  const ids = (Array.isArray(faceIds) ? faceIds : [faceIds])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (ids.length === 0) return { ok: true, deleted: [] };

  const config = runtimeConfig();
  const { response, error } = await send(
    "DeleteFaces",
    new DeleteFacesCommand({
      CollectionId: config.rekognitionCollectionId,
      FaceIds: ids,
    })
  );
  if (error) return providerFailure("DeleteFaces", error);

  incrementMetric("rekognition_delete_success_total");
  return { ok: true, deleted: response?.DeletedFaces || [] };
}

export function facesToEvict(existingFaceIds, { adding = 1 } = {}) {
  const config = runtimeConfig();
  const current = (Array.isArray(existingFaceIds) ? existingFaceIds : []).filter(Boolean);
  const overflow = current.length + adding - config.rekognitionMaxFacesPerInstructor;
  if (overflow <= 0) return [];
  return current.slice(0, overflow);
}

export async function detectFacesForGroup(imageBuffer, { maxFaces = 0 } = {}) {
  if (!isFaceRecognitionConfigured()) return failure(FACE_REASONS.NOT_CONFIGURED);
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return failure(FACE_REASONS.NO_FACE);
  }

  const { response, error } = await send(
    "DetectFaces",
    new DetectFacesCommand({
      Image: { Bytes: imageBuffer },
      Attributes: ["DEFAULT"],
    })
  );
  if (error) return providerFailure("DetectFaces", error);

  const details = response?.FaceDetails || [];
  if (details.length === 0) return failure(FACE_REASONS.NO_FACE);
  if (maxFaces > 0 && details.length > maxFaces) {
    incrementMetric("rekognition_group_too_many_faces_total");
    return {
      ok: false,
      reason: FACE_REASONS.MULTIPLE_FACES,
      message: `This photo has ${details.length} people in it. Take it again with at most ${maxFaces}.`,
      detected: details.length,
    };
  }

  const config = runtimeConfig();
  const faces = details.map((detail, index) => ({
    index,
    box: {
      left: Number(detail?.BoundingBox?.Left ?? 0),
      top: Number(detail?.BoundingBox?.Top ?? 0),
      width: Number(detail?.BoundingBox?.Width ?? 0),
      height: Number(detail?.BoundingBox?.Height ?? 0),
    },
    confidence: Number(detail?.Confidence ?? 0),
    sharpness: Number(detail?.Quality?.Sharpness ?? 0),
    brightness: Number(detail?.Quality?.Brightness ?? 0),
    yaw: Number(detail?.Pose?.Yaw ?? 0),
    pitch: Number(detail?.Pose?.Pitch ?? 0),
  }))
    .filter((face) => face.confidence >= config.rekognitionMinFaceConfidence
      && face.box.width > 0
      && face.box.height > 0);

  if (faces.length === 0) {
    incrementMetric("rekognition_group_no_usable_face_total");
    return failure(FACE_REASONS.NO_FACE);
  }

  incrementMetric("rekognition_group_detect_total");
  return { ok: true, faces, detected: details.length };
}
