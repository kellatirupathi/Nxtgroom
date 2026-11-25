import { Router } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { asyncRoute, createDocument } from "../utils.js";
import { requireSuperAdmin } from "../middleware/auth.js";
import { validateImageUpload } from "../imageValidation.js";
import { isPhotoStorageConfigured } from "../services/photoStorage.js";
import { isValidDateKey, localDateKey } from "../services/instructorReports.js";
import {
  activeCollegeNames,
  buildPhotoPeople,
  ensureFormLinks,
  findFormLink,
  findFormResponse,
  formInstructors,
  FORM_IMPORT_MAX_ROWS,
  FORM_MAX_CROP_BYTES,
  FORM_MAX_CROPS,
  FORM_MAX_FILE_BYTES,
  FORM_MAX_PHOTOS,
  importFormResponses,
  listFormResponses,
  readFormAnswers,
  readKeptPhotoIds,
  readPeoplePlan,
  removeFormPhotos,
  removePersonCrops,
  resolveFormDate,
  serializeFormResponse,
  newFormPhotoId,
  storeFormPhoto,
} from "../services/instituteForms.js";

// Public: anyone holding an institute's link can open and fill in its form.
export const publicFormRouter = Router();
// Signed-in administrators: the links, the responses and importing a sheet.
export const formAdminRouter = Router();

const FORM_NOT_FOUND = "This form link is not valid. Ask your coordinator for the current link.";
const EXPORT_LINK_SECONDS = 7 * 24 * 60 * 60;

const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { detail: "Too many requests. Please try again in a few minutes." },
});

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { detail: "Too many submissions. Please try again in a few minutes." },
});

// Each submission can hold five 10 MB photos in memory, so only a few are
// received at once; the rest are asked to retry in a moment.
const MAX_ACTIVE_UPLOADS = 4;
let activeUploads = 0;

function uploadGate(_req, res, next) {
  if (activeUploads >= MAX_ACTIVE_UPLOADS) {
    res.set("Retry-After", "10");
    return res.status(503).json({ detail: "Many forms are being sent right now. Please wait a few seconds and press Submit again." });
  }
  activeUploads += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeUploads -= 1;
  };
  res.once("finish", release);
  res.once("close", release);
  return next();
}

// Up to five photos plus the small cut-outs of the people in them.
const formUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: FORM_MAX_FILE_BYTES,
    files: FORM_MAX_PHOTOS + FORM_MAX_CROPS,
    fields: 16,
    fieldSize: 256 * 1024,
    parts: FORM_MAX_PHOTOS + FORM_MAX_CROPS + 16,
  },
});

function receivePhotos(req, res, next) {
  formUpload.fields([
    { name: "photos", maxCount: FORM_MAX_PHOTOS },
    { name: "crops", maxCount: FORM_MAX_CROPS },
  ])(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ detail: "Each photo must be 10 MB or smaller." });
    }
    if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(422).json({ detail: `You can upload up to ${FORM_MAX_PHOTOS} photos.` });
    }
    return res.status(400).json({ detail: "The form could not be read. Please try again." });
  });
}

function instituteView(college) {
  return { name: college.name, location: college.location || "" };
}

function limitsView() {
  return { max_photos: FORM_MAX_PHOTOS, max_file_mb: FORM_MAX_FILE_BYTES / (1024 * 1024) };
}

publicFormRouter.get(
  "/:token",
  readLimiter,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const found = await findFormLink(db, req.params.token);
    if (!found) return res.status(404).json({ detail: FORM_NOT_FOUND });
    const today = localDateKey(new Date());
    const requested = typeof req.query.date === "string" ? req.query.date : undefined;
    const resolved = resolveFormDate(requested, today);
    if (resolved.error) {
      return res.status(422).json({ detail: resolved.error, today, institute: instituteView(found.college), limits: limitsView() });
    }
    const response = await findFormResponse(db, found.college._id, resolved.date);
    return res.json({
      institute: instituteView(found.college),
      date: resolved.date,
      today,
      limits: limitsView(),
      response: response ? await serializeFormResponse(response, { collegeName: found.college.name }) : null,
    });
  })
);

// The institute's instructors, to name the people in a group photo.
publicFormRouter.get(
  "/:token/instructors",
  readLimiter,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const found = await findFormLink(db, req.params.token);
    if (!found) return res.status(404).json({ detail: FORM_NOT_FOUND });
    return res.json(await formInstructors(db, found.college._id));
  })
);

publicFormRouter.post(
  "/:token/:date",
  submitLimiter,
  uploadGate,
  receivePhotos,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const found = await findFormLink(db, req.params.token);
    if (!found) return res.status(404).json({ detail: FORM_NOT_FOUND });
    const today = localDateKey(new Date());
    const resolved = resolveFormDate(req.params.date, today);
    if (resolved.error) return res.status(422).json({ detail: resolved.error });
    const date = resolved.date;
    // Only today's form can be sent or changed; earlier days are view only
    // (past data is added by the admins, from Form Responses > Import).
    if (date !== today) {
      return res.status(403).json({ detail: "Earlier days can only be viewed. Only today's form can be sent or changed. Reload the page to open today's form." });
    }
    const collegeId = String(found.college._id);

    const answers = readFormAnswers(req.body);
    const kept = readKeptPhotoIds(req.body?.keep);
    if (kept === null) return res.status(400).json({ detail: "The form could not be read. Please reload the page and try again." });
    // Photos may be in any format (and any size): each is opened, checked and
    // turned into a JPEG when it is stored, below.
    const files = Array.isArray(req.files?.photos) ? req.files.photos : [];
    for (const file of files) {
      if (!file?.buffer?.length) return res.status(422).json({ detail: `${file?.originalname || "A file"}: the file is empty. Please choose the photo again.` });
    }
    // The people the submitter's browser found in the photos: their cut-outs
    // and the instructor chosen for each.
    const plan = readPeoplePlan(req.body?.people);
    if (plan === null) return res.status(400).json({ detail: "The people in the photos could not be read. Please reload the page and try again." });
    const crops = [];
    for (const file of Array.isArray(req.files?.crops) ? req.files.crops : []) {
      const checked = validateImageUpload(file);
      if (!checked.valid) return res.status(422).json({ detail: "One of the people's pictures could not be read. Please add the photo again." });
      if (file.size > FORM_MAX_CROP_BYTES) return res.status(413).json({ detail: "One of the people's pictures is too large. Please add the photo again." });
      crops.push({ buffer: file.buffer, mimeType: checked.mimeType });
    }

    // The saved response and (when people are sent) the instructor list,
    // looked up together.
    const [existing, instructors] = await Promise.all([
      findFormResponse(db, collegeId, date),
      answers.status === "yes" && plan.length ? formInstructors(db, collegeId) : [],
    ]);
    const existingPhotos = Array.isArray(existing?.photos) ? existing.photos : [];
    const keptPhotos = answers.status === "yes" ? existingPhotos.filter((photo) => kept.includes(photo.id)) : [];
    const photoLinks = answers.status === "yes" && Array.isArray(existing?.photo_links) ? existing.photo_links : [];
    const errors = { ...answers.errors };
    if (answers.status === "no" && files.length) {
      errors.photos = "Photos are only sent when Photo Submission Status is Yes.";
    } else if (answers.status === "yes") {
      const total = keptPhotos.length + files.length;
      if (total > FORM_MAX_PHOTOS) errors.photos = `You can upload up to ${FORM_MAX_PHOTOS} photos.`;
      else if (total + photoLinks.length === 0) errors.photos = "This is a required question";
    }
    if (Object.keys(errors).length) {
      return res.status(422).json({ detail: "Please answer the questions marked in red.", errors });
    }
    if ((files.length || crops.length) && !isPhotoStorageConfigured()) {
      return res.status(503).json({ detail: "Photo storage is not available right now. Please try again later." });
    }

    // Each photo's people: saved photos keep theirs unless the form sent a
    // new list for them; new photos ("new:<n>", in upload order) get theirs.
    // Every photo, its preview and everyone's picture are sent to storage at
    // the same time (new photos get their ids first so their people's
    // pictures need not wait for them).
    const planByPhoto = new Map((answers.status === "yes" ? plan : []).map((entry) => [entry.photo, entry]));
    const roster = new Map(instructors.map((instructor) => [instructor.id, instructor]));
    const newIds = files.map(() => newFormPhotoId());
    const peopleFor = (photoKey, existingPeople, photoId) => {
      const entry = planByPhoto.get(photoKey);
      return entry
        ? buildPhotoPeople({ entry, existing: existingPeople, crops, roster, collegeId, date, photoId })
        : Promise.resolve(null);
    };
    const [storedPhotos, keptBuilt, newBuilt] = await Promise.all([
      Promise.allSettled(files.map((file, index) => storeFormPhoto({ buffer: file.buffer, collegeId, date, id: newIds[index] }))),
      Promise.allSettled(keptPhotos.map((photo) => peopleFor(photo.id, photo.people, photo.id))),
      Promise.allSettled(newIds.map((id, index) => peopleFor(`new:${index}`, [], id))),
    ]);
    const added = storedPhotos.filter((item) => item.status === "fulfilled" && item.value.photo).map((item) => item.value.photo);
    const builds = [...keptBuilt, ...newBuilt];
    const newCrops = builds.filter((item) => item.status === "fulfilled" && item.value).flatMap((item) => item.value.stored);
    const photoFailed = storedPhotos.find((item) => item.status === "rejected" || item.value.error);
    const peopleFailed = builds.find((item) => item.status === "rejected");
    if (photoFailed || peopleFailed) {
      await Promise.all([removePersonCrops(newCrops), removeFormPhotos(added)]);
      if (photoFailed?.status === "fulfilled") {
        return res.status(photoFailed.value.status).json({ detail: photoFailed.value.error });
      }
      const error = photoFailed?.reason ?? peopleFailed.reason;
      if (error?.status) return res.status(error.status).json({ detail: error.message });
      throw error;
    }
    const removedPeople = [];
    const photos = [];
    keptPhotos.forEach((photo, index) => {
      const built = keptBuilt[index].value;
      if (!built) {
        photos.push(photo);
        return;
      }
      removedPeople.push(...built.removed);
      photos.push({ ...photo, people: built.people });
    });
    added.forEach((photo, index) => {
      photos.push({ ...photo, people: newBuilt[index].value?.people ?? [] });
    });

    const now = new Date();
    const fields = {
      college_name: found.college.name,
      status: answers.status,
      submitted_by: answers.submittedBy,
      reason: answers.reason,
      reason_other: answers.reasonOther,
      photos,
      photo_links: photoLinks,
      updated_at: now,
    };
    let saved;
    try {
      if (existing) {
        await db.collection("form_responses").updateOne(
          { _id: existing._id },
          { $set: fields, $inc: { edit_count: 1 } }
        );
        saved = { ...existing, ...fields, edit_count: (Number(existing.edit_count) || 0) + 1 };
      } else {
        saved = createDocument({
          college_id: collegeId,
          form_date: date,
          ...fields,
          source: "automatic",
          submitted_at: now,
          edit_count: 0,
        });
        await db.collection("form_responses").insertOne(saved);
      }
    } catch (error) {
      await removePersonCrops(newCrops);
      await removeFormPhotos(added);
      if (error?.code === 11000) {
        return res.status(409).json({ detail: "A response for this date was just sent from another device. Reload the page to see it and edit it." });
      }
      throw error;
    }

    const keptIds = new Set(saved.photos.map((photo) => photo.id));
    const removed = existingPhotos.filter((photo) => !keptIds.has(photo.id));
    if (removed.length) {
      void removeFormPhotos(removed).catch(() => {});
    }
    if (removedPeople.length) {
      void removePersonCrops(removedPeople).catch(() => {});
    }
    return res.status(existing ? 200 : 201).json({
      response: await serializeFormResponse(saved, { collegeName: found.college.name }),
    });
  })
);

formAdminRouter.get(
  "/form-links",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    return res.json(await ensureFormLinks(req.app.locals.db));
  })
);

formAdminRouter.get(
  "/form-responses",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const from = typeof req.query.from === "string" ? req.query.from : "";
    const to = typeof req.query.to === "string" ? req.query.to : "";
    if ((from && !isValidDateKey(from)) || (to && !isValidDateKey(to))) {
      return res.status(422).json({ detail: "from and to must be dates in YYYY-MM-DD format" });
    }
    if (from && to && from > to) return res.status(422).json({ detail: "from must be on or before to" });
    const expiresIn = req.query.export === "1" ? EXPORT_LINK_SECONDS : 3600;
    const [rows, names] = await Promise.all([listFormResponses(db, { from, to }), activeCollegeNames(db)]);
    const serialized = await Promise.all(rows.map((row) => serializeFormResponse(row, {
      collegeName: names.get(String(row.college_id)) ?? row.college_name ?? "",
      expiresIn,
    })));
    return res.json(serialized);
  })
);

const IMPORT_FIELDS = ["date", "status", "university", "picture", "submitted_by", "reason", "timestamp"];

formAdminRouter.post(
  "/form-responses/import",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(422).json({ detail: "Add at least one row to import." });
    }
    if (rows.length > FORM_IMPORT_MAX_ROWS) {
      return res.status(422).json({ detail: `Import at most ${FORM_IMPORT_MAX_ROWS} rows at a time.` });
    }
    const cleaned = rows.map((row, index) => {
      const value = row && typeof row === "object" && !Array.isArray(row) ? row : {};
      const out = { row: Number.isSafeInteger(value.row) ? value.row : index + 2 };
      for (const field of IMPORT_FIELDS) {
        out[field] = typeof value[field] === "string" ? value[field].slice(0, field === "picture" ? 4000 : 400) : "";
      }
      return out;
    });
    const result = await importFormResponses(req.app.locals.db, cleaned, {
      today: localDateKey(new Date()),
      importedBy: req.currentUser?.email || null,
    });
    return res.json(result);
  })
);
