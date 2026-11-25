// Finds and names the people in institute form photos after the form is sent,
// so the institute only uploads photos and Submit stays quick.
//
// Each new photo is saved with people_status "pending". This worker takes one
// pending photo at a time (a short lease, so a stopped server's work is taken
// up again), asks Rekognition for the faces in it and the words printed in it
// (faces are only found, never searched for or kept), cuts each person out
// head to feet, names them from their label (services/formPeopleReading.js),
// stores the cut-outs in R2 and saves the people on the photo ("done"). A
// photo that cannot be read is tried again a few times, then left "failed".
//
// Sending a form wakes the worker at once; otherwise it looks for work now
// and then (photos left by a restart). Only the last few days are looked at:
// forms can only be sent for today.

import crypto from "node:crypto";
import sharp from "sharp";
import { detectFacesForGroup, detectTextWords, FACE_REASONS, isFaceRecognitionConfigured } from "./faceRecognition.js";
import { planPhotoPeople } from "./formPeopleReading.js";
import { formInstructors, formPersonKey, mapWithLimit, PEOPLE_STATUS, removePersonCrops } from "./instituteForms.js";
import { localDateKey } from "./instructorReports.js";
import { downloadPhoto, isPhotoStorageConfigured, uploadPhoto } from "./photoStorage.js";
import { incrementMetric } from "./telemetry.js";
import { createWorkerMonitor } from "./workerHealth.js";
import { createIdleBackoff, createWakeSignal } from "./workerPacing.js";

const WORKER_ID = crypto.randomUUID();
const RESPONSES = "form_responses";
const LEASE_MS = 3 * 60_000;
export const PEOPLE_MAX_ATTEMPTS = 3;
const RECENT_DAYS = 3;
const IDLE_MIN_MS = 5_000;
const IDLE_MAX_MS = 2 * 60_000;
const CROP_MAX_SIDE = 600;
const UPLOAD_CONCURRENCY = 6;
// Rekognition takes photos of up to 5 MB.
const DETECTION_MAX_BYTES = Math.floor(4.5 * 1024 * 1024);
const DETECTION_MAX_SIDE = 2048;

const wake = createWakeSignal();

// Called when a form is sent with new photos.
export function wakeFormPeopleWorker() {
  wake.notify();
}

// Whether a photo's people are waiting to be read (or were being read by a
// worker that stopped), at `now` (milliseconds).
export function photoNeedsReading(photo, now = Date.now()) {
  if (!photo?.id || !photo?.key) return false;
  if (photo.people_status === PEOPLE_STATUS.PENDING) return !(Number(photo.people_available_at) > now);
  if (photo.people_status === PEOPLE_STATUS.PROCESSING) return !(Number(photo.people_lease_until) > now);
  return false;
}

async function nextPhoto(db, now) {
  const since = localDateKey(new Date(now - RECENT_DAYS * 24 * 60 * 60 * 1000));
  const rows = await db.collection(RESPONSES).find({ form_date: { $gte: since } }).toArray();
  rows.sort((a, b) => String(a.form_date).localeCompare(String(b.form_date)));
  for (const row of rows) {
    for (const photo of Array.isArray(row.photos) ? row.photos : []) {
      if (photoNeedsReading(photo, now)) return { row, photo };
    }
  }
  return null;
}

// The document store takes one change per array in an update, so each change
// replaces this one photo's entry as a whole (its other fields as read, with
// `changes` on top; a change of undefined removes that field). The filter
// makes sure the photo is still in the state it was read in.
async function changePhoto(db, filter, photo, changes) {
  const next = { ...photo, ...changes };
  for (const [field, value] of Object.entries(next)) {
    if (value === undefined) delete next[field];
  }
  const result = await db.collection(RESPONSES).updateOne(
    filter,
    { $set: { "photos.$[p]": next } },
    { arrayFilters: [{ "p.id": photo.id }] }
  );
  return result.modifiedCount === 1;
}

// Takes the photo for this worker, unless another worker just did.
async function claimPhoto(db, row, photo, now, attempts) {
  const match = { id: photo.id, people_status: photo.people_status };
  if (photo.people_status === PEOPLE_STATUS.PROCESSING) match.people_lease_until = photo.people_lease_until;
  return changePhoto(db, { _id: row._id, photos: { $elemMatch: match } }, photo, {
    people_status: PEOPLE_STATUS.PROCESSING,
    people_lease_until: now + LEASE_MS,
    people_worker: WORKER_ID,
    people_attempts: attempts,
  });
}

const heldByThisWorker = (row, photo) => ({
  _id: row._id,
  photos: { $elemMatch: { id: photo.id, people_status: PEOPLE_STATUS.PROCESSING, people_worker: WORKER_ID } },
});

const NO_LEASE = { people_lease_until: undefined, people_worker: undefined };

// Saves the people on the photo. When the photo was removed (or taken up by
// another worker) meanwhile, the cut-outs just stored are deleted again.
async function savePeople(db, row, photo, people, attempts) {
  const saved = await changePhoto(db, heldByThisWorker(row, photo), photo, {
    people,
    people_status: PEOPLE_STATUS.DONE,
    people_attempts: attempts,
    people_read_at: Date.now(),
    people_available_at: undefined,
    people_error: undefined,
    ...NO_LEASE,
  });
  if (!saved) {
    await removePersonCrops(people);
    return false;
  }
  // People from an earlier, unfinished reading of this photo are replaced.
  if (Array.isArray(photo.people) && photo.people.length) await removePersonCrops(photo.people);
  return true;
}

// Puts the photo back to be tried again a little later, or gives up.
async function releasePhoto(db, row, photo, { attempts, code, final }) {
  const giveUp = final || attempts >= PEOPLE_MAX_ATTEMPTS;
  await changePhoto(
    db,
    giveUp ? { _id: row._id, photos: { $elemMatch: { id: photo.id } } } : heldByThisWorker(row, photo),
    photo,
    {
      people_status: giveUp ? PEOPLE_STATUS.FAILED : PEOPLE_STATUS.PENDING,
      people_attempts: Math.min(attempts, PEOPLE_MAX_ATTEMPTS),
      people_error: code,
      people_available_at: Date.now() + 60_000 * 2 ** Math.max(0, attempts - 1),
      ...NO_LEASE,
    }
  );
  incrementMetric(giveUp ? "form_people_failed_total" : "form_people_retry_total");
}

function problem(code, { final = false } = {}) {
  return Object.assign(new Error(code), { code, final });
}

// The photo upright, and small enough for Rekognition.
async function readablePhoto(buffer) {
  const meta = await sharp(buffer, { failOn: "none" }).metadata();
  const turned = Number(meta.orientation) > 1;
  if (!turned && buffer.length <= DETECTION_MAX_BYTES && meta.width && meta.height) {
    return { buffer, width: meta.width, height: meta.height };
  }
  const { data, info } = await sharp(buffer, { failOn: "none" })
    .rotate()
    .resize({ width: DETECTION_MAX_SIDE, height: DETECTION_MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

async function cutOut(photo, box) {
  const left = Math.max(0, Math.min(photo.width - 1, Math.floor(box.left * photo.width)));
  const top = Math.max(0, Math.min(photo.height - 1, Math.floor(box.top * photo.height)));
  const width = Math.max(1, Math.min(photo.width - left, Math.round(box.width * photo.width)));
  const height = Math.max(1, Math.min(photo.height - top, Math.round(box.height * photo.height)));
  return sharp(photo.buffer, { failOn: "none" })
    .extract({ left, top, width, height })
    .resize({ width: CROP_MAX_SIDE, height: CROP_MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

// Everyone in one stored photo, cut out, stored and named. Throws (with a
// `code`) when the photo cannot be read now.
export async function readPhotoPeople({ buffer, roster, collegeId, date, photoId }) {
  const photo = await readablePhoto(buffer);
  const [faces, text] = await Promise.all([detectFacesForGroup(photo.buffer), detectTextWords(photo.buffer)]);
  if (!faces.ok && faces.reason !== FACE_REASONS.NO_FACE) {
    throw problem(faces.reason || "FACE_DETECTION_FAILED", { final: faces.reason === FACE_REASONS.NOT_CONFIGURED });
  }
  // Without the labels everyone is still cut out, just not named.
  if (!text.ok) console.warn(`Form photo labels could not be read (${text.reason})`);
  const plan = planPhotoPeople({
    faces: faces.ok ? faces.faces.map((face) => face.box) : [],
    words: text.ok ? text.words : [],
    roster,
    aspect: photo.width / photo.height,
  });
  const people = plan.map(({ box, ...naming }) => {
    const id = crypto.randomBytes(6).toString("base64url");
    return { id, crop_key: formPersonKey(collegeId, date, photoId, id), ...naming, box };
  });
  const stored = await mapWithLimit(people, UPLOAD_CONCURRENCY, async (person) => {
    try {
      const crop = await cutOut(photo, person.box);
      return await uploadPhoto({
        key: person.crop_key,
        body: crop,
        mimeType: "image/jpeg",
        metadata: { college_id: String(collegeId), form_date: date, kind: "form_person" },
      });
    } catch {
      return { stored: false };
    }
  });
  if (stored.some((result) => !result?.stored)) {
    await removePersonCrops(people.filter((_, index) => stored[index]?.stored));
    throw problem("CROP_UPLOAD_FAILED");
  }
  return people;
}

// Reads the next waiting photo, if any. Returns whether there was one.
export async function readNextFormPhoto(db, now = Date.now()) {
  const next = await nextPhoto(db, now);
  if (!next) return false;
  const { row, photo } = next;
  const attempts = (Number(photo.people_attempts) || 0) + 1;
  if (attempts > PEOPLE_MAX_ATTEMPTS) {
    await releasePhoto(db, row, photo, { attempts, code: photo.people_error || "LEASE_EXPIRED", final: true });
    return true;
  }
  if (!(await claimPhoto(db, row, photo, now, attempts))) return true;
  try {
    if (!isFaceRecognitionConfigured()) throw problem(FACE_REASONS.NOT_CONFIGURED, { final: true });
    if (!isPhotoStorageConfigured()) throw problem("STORAGE_NOT_CONFIGURED", { final: true });
    const [{ buffer }, roster] = await Promise.all([downloadPhoto(photo.key), formInstructors(db, row.college_id)]);
    const people = await readPhotoPeople({
      buffer,
      roster,
      collegeId: String(row.college_id),
      date: row.form_date,
      photoId: photo.id,
    });
    if (await savePeople(db, row, { ...photo, people_status: PEOPLE_STATUS.PROCESSING }, people, attempts)) incrementMetric("form_people_read_total");
  } catch (error) {
    const code = String(error?.code || error?.name || "FORM_PEOPLE_ERROR");
    console.error(`Form photo people could not be read (${code})`);
    await releasePhoto(db, row, photo, { attempts, code, final: Boolean(error?.final) });
  }
  return true;
}

export function startFormPeopleWorker(db) {
  let stopped = false;
  let timer = null;
  let running = false;
  let wokenWhileRunning = false;
  let inFlight = Promise.resolve();
  const monitor = createWorkerMonitor("form_people", { busyStaleAfterMs: LEASE_MS + 60_000 });
  const backoff = createIdleBackoff({ minMs: IDLE_MIN_MS, maxMs: IDLE_MAX_MS });
  const schedule = (delay) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, delay);
  };
  function tick() {
    if (running || stopped) return;
    running = true;
    wokenWhileRunning = false;
    monitor.cycleStarted();
    let loopError = null;
    let worked = false;
    inFlight = (async () => {
      try {
        worked = await readNextFormPhoto(db);
        monitor.progress(worked ? "job_claimed" : "queue_idle");
      } catch (error) {
        loopError = String(error?.code || error?.name || "FORM_PEOPLE_ERROR");
        console.error(`Form people worker error (${loopError})`);
      } finally {
        running = false;
        monitor.cycleCompleted(loopError);
        const delay = backoff.afterCycle(worked || wokenWhileRunning);
        schedule(loopError ? Math.max(30_000, delay) : delay);
      }
    })();
  }
  const stopListening = wake.listen(() => {
    backoff.reset();
    if (running) wokenWhileRunning = true;
    else schedule(0);
  });
  schedule(0);
  return {
    async stop() {
      stopped = true;
      stopListening();
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
