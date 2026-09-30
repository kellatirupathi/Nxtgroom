import {
  buildReferencePhotoKey,
  deletePhoto,
  uploadPhoto,
} from "./photoStorage.js";
import {
  checkFaceQuality,
  deleteFaces,
  facesToEvict,
  indexFace,
} from "./faceRecognition.js";

function activeFilter(extra = {}) {
  return {
    $and: [
      extra,
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
    ],
  };
}

/**
 * Queues an R2 object for deletion after an inline delete failed.
 *
 * The cleanup collection keys a job by the object key itself, so requesting the
 * same deletion twice is a no-op rather than a duplicate job. Mirrors
 * compensateUploadedPhoto in the attendance routes: the photo is removed
 * immediately in the normal case, and a transient storage outage leaves a
 * durable retry instead of an orphaned file nothing points at.
 */
export async function queuePhotoCleanup(db, key, reason, lastError) {
  if (!key) return;
  const now = new Date();
  await db.collection("storage_cleanup_jobs").updateOne(
    { _id: key },
    {
      $setOnInsert: {
        _id: key,
        key,
        reason,
        status: "queued",
        attempts: 0,
        available_at: now,
        created_at: now,
      },
      $set: { updated_at: now, last_error: lastError || "delete_failed" },
    },
    { upsert: true }
  );
}

/** Removes a reference photo from R2 now, or queues it if storage refuses. */
export async function discardReferencePhoto(db, key, reason) {
  if (!key) return;
  const result = await deletePhoto(key);
  if (!result.deleted) await queuePhotoCleanup(db, key, reason, result.reason);
}

function refusal(status, detail, reason) {
  return { ok: false, status, detail, ...(reason ? { reason } : {}) };
}

/**
 * Stores and enrolls one normalized photograph as an instructor's reference.
 *
 * mode=add keeps the faces already enrolled, so recognition improves as admins
 * correct it: one photograph in one lighting condition fails repeatedly in
 * others, and several embeddings of the same person are the fix. mode=replace
 * discards the previous face and photo, for a reference that turned out to be
 * the wrong person or too poor to keep.
 *
 * Ordering is deliberate. The new face is indexed BEFORE the old one is
 * removed: if indexing fails the instructor keeps a working reference rather
 * than being left with none, and a brief moment holding two faces is harmless
 * where a moment holding zero breaks recognition for that person.
 *
 * `checkedQuality` skips the quality check for a caller that has just run it
 * on the same bytes, so one photograph is not paid for twice.
 *
 * Returns { ok: true, ... } or a refusal carrying the HTTP status and wording
 * the admin screen shows.
 */
export async function enrollReferencePhoto(db, instructor, normalized, {
  mode = "add",
  checkedQuality = null,
} = {}) {
  // Quality is judged before anything is stored or indexed. A blurry or
  // half-turned reference never fails loudly; it produces confident wrong
  // matches for as long as it stays in the collection, so refusing it here
  // costs the admin one retake and prevents misfiled attendance later.
  const quality = checkedQuality
    ? { ok: true, quality: checkedQuality }
    : await checkFaceQuality(normalized.buffer);
  if (!quality.ok) {
    return refusal(quality.reason === "PROVIDER_ERROR" ? 503 : 422, quality.message, quality.reason);
  }

  const photoKey = buildReferencePhotoKey({
    instructorId: String(instructor._id),
    mimeType: normalized.mimeType,
  });
  const stored = await uploadPhoto({
    key: photoKey,
    body: normalized.buffer,
    mimeType: normalized.mimeType,
    metadata: { instructor_id: String(instructor._id), kind: "reference" },
  });
  if (!stored.stored) {
    return refusal(503, "The reference photo could not be stored. Try again.");
  }

  const indexed = await indexFace(normalized.buffer, String(instructor._id));
  if (!indexed.ok) {
    // Nothing was enrolled, so the object just written has no owner.
    await discardReferencePhoto(db, photoKey, "reference_index_failed");
    return refusal(indexed.reason === "PROVIDER_ERROR" ? 503 : 422, indexed.message, indexed.reason);
  }

  const existingFaceIds = Array.isArray(instructor.face_ids)
    ? instructor.face_ids.filter(Boolean).map(String)
    : [];
  const existingPhotoKey = instructor.reference_photo_key || null;

  // replace discards every earlier face; add keeps them and drops only what
  // overflows the cap, oldest first, since the newest photographs come from
  // the tablet and lighting actually in use.
  const retiredFaceIds = mode === "replace"
    ? existingFaceIds
    : facesToEvict(existingFaceIds, { adding: 1 });
  const keptFaceIds = existingFaceIds.filter((id) => !retiredFaceIds.includes(id));
  const faceIds = [...keptFaceIds, indexed.faceId];

  const now = new Date();
  const update = await db.collection("instructors").updateOne(
    activeFilter({ _id: instructor._id }),
    {
      $set: {
        face_ids: faceIds,
        reference_photo_key: photoKey,
        face_indexed_at: now,
        updated_at: now,
      },
    }
  );
  if (!update.matchedCount) {
    // The instructor was removed while the photo was being processed.
    await discardReferencePhoto(db, photoKey, "reference_owner_missing");
    await deleteFaces([indexed.faceId]);
    return refusal(404, "Instructor not found");
  }

  // Only now that the record points at the new face is the old one removed.
  if (retiredFaceIds.length) await deleteFaces(retiredFaceIds);
  if (mode === "replace" && existingPhotoKey && existingPhotoKey !== photoKey) {
    await discardReferencePhoto(db, existingPhotoKey, "reference_replaced");
  }

  return {
    ok: true,
    faceIds,
    retiredFaceIds,
    photoKey,
    quality: quality.quality,
  };
}
