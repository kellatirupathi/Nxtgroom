import crypto from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { runtimeConfig } from "../config/env.js";
import { incrementMetric } from "./telemetry.js";

let client = null;
let clientFingerprint = "";

function config() {
  return {
    endpoint: process.env.R2_ENDPOINT,
    bucket: process.env.R2_BUCKET,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  };
}

export function isPhotoStorageConfigured() {
  const { endpoint, bucket, accessKeyId, secretAccessKey } = config();
  return Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
}

export async function checkPhotoStorageConnection() {
  if (!isPhotoStorageConfigured()) return false;
  try {
    await getClient().send(new HeadBucketCommand({ Bucket: config().bucket }));
    return true;
  } catch {
    return false;
  }
}

function getClient() {
  const { endpoint, accessKeyId, secretAccessKey } = config();
  const fingerprint = `${endpoint}|${accessKeyId}`;
  if (!client || clientFingerprint !== fingerprint) {
    client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      requestHandler: { requestTimeout: runtimeConfig().r2TimeoutMs },
    });
    clientFingerprint = fingerprint;
  }
  return client;
}

const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function buildPhotoKey({ instructorId, kind, mimeType, now = new Date() }) {
  const extension = EXTENSIONS[mimeType] || "jpg";
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const safeInstructor = String(instructorId).replace(/[^A-Za-z0-9_-]/g, "");
  const unique = crypto.randomBytes(8).toString("hex");
  return `attendance/${year}/${month}/${day}/${safeInstructor}-${kind}-${unique}.${extension}`;
}

export function buildReferencePhotoKey({ instructorId, mimeType, now = new Date() }) {
  const extension = EXTENSIONS[mimeType] || "jpg";
  const safeInstructor = String(instructorId).replace(/[^A-Za-z0-9_-]/g, "");
  const unique = crypto.randomBytes(8).toString("hex");
  return `reference/${safeInstructor}/${now.getTime()}-${unique}.${extension}`;
}

export async function uploadPhoto({ key, body, mimeType, metadata = {} }) {
  if (!isPhotoStorageConfigured()) {
    return { stored: false, reason: "storage_not_configured" };
  }
  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: config().bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
        Metadata: Object.fromEntries(
          Object.entries(metadata)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([name, value]) => [name, String(value)])
        ),
      })
    );
    incrementMetric("r2_upload_success_total");
    return { stored: true, key };
  } catch (error) {
    incrementMetric("r2_upload_failures_total");
    console.error(`R2 upload failed for ${key}: ${error?.name || "Error"}`);
    return { stored: false, reason: error?.name || "upload_failed" };
  }
}

export async function getPhotoUrl(key, { expiresIn = 900 } = {}) {
  if (!isPhotoStorageConfigured() || !key) return null;
  try {
    return await getSignedUrl(
      getClient(),
      new GetObjectCommand({ Bucket: config().bucket, Key: key }),
      { expiresIn }
    );
  } catch (error) {
    console.error(`R2 presign failed for ${key}: ${error?.name || "Error"}`);
    return null;
  }
}

export async function downloadPhoto(key) {
  if (!isPhotoStorageConfigured()) throw new Error("Photo storage is not configured");
  if (!key) throw new Error("Photo key is required");
  const response = await getClient().send(
    new GetObjectCommand({ Bucket: config().bucket, Key: key })
  );
  if (!response.Body) throw new Error(`Photo ${key} has no content`);
  const bytes = await response.Body.transformToByteArray();
  return {
    buffer: Buffer.from(bytes),
    mimeType: response.ContentType || "image/jpeg",
  };
}

export async function deletePhoto(key) {
  if (!isPhotoStorageConfigured() || !key) return { deleted: false };
  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: config().bucket, Key: key })
    );
    return { deleted: true };
  } catch (error) {
    console.error(`R2 delete failed for ${key}: ${error?.name || "Error"}`);
    return { deleted: false, reason: error?.name || "delete_failed" };
  }
}

export async function listPhotoObjects({ continuationToken, maxKeys = 200 } = {}) {
  if (!isPhotoStorageConfigured()) return { objects: [], nextToken: null };
  const response = await getClient().send(new ListObjectsV2Command({
    Bucket: config().bucket,
    Prefix: "attendance/",
    MaxKeys: Math.max(1, Math.min(1000, maxKeys)),
    ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
  }));
  return {
    objects: (response.Contents || []).map((item) => ({
      key: item.Key,
      lastModified: item.LastModified || null,
    })).filter((item) => item.key),
    nextToken: response.IsTruncated ? response.NextContinuationToken || null : null,
  };
}
