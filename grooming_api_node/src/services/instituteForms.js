// The daily grooming-photo form each institute fills in through its own public
// link (like the Google Form it replaces).
//
// - Every active institute gets one link, /form/<name-slug>/<token>. The token
//   alone identifies the institute; the slug only makes the link readable, so
//   renaming an institute does not break links already shared.
// - One response per institute per day ("form_date", YYYY-MM-DD in the app
//   time zone). Opening the link shows that day's form, or the saved answers
//   with an "Edit response" button once it is submitted. Any earlier date can
//   be opened and edited too; future dates cannot.
// - Photos go to Cloudflare R2 under forms/, with a small preview copy for the
//   thumbnails. Responses sent through the link are "automatic"; rows an admin
//   imports from an existing sheet are "manual".

import crypto from "node:crypto";
import sharp from "sharp";
import { createDocument } from "../utils.js";
import { normalizeInstructorImage } from "../imageProcessor.js";
import { isValidDateKey } from "./instructorReports.js";
import { deletePhoto, getPhotoUrl, uploadPhoto } from "./photoStorage.js";

export const FORM_MAX_PHOTOS = 5;
export const FORM_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FORM_EARLIEST_DATE = "2020-01-01";
export const FORM_STATUSES = Object.freeze(["yes", "no"]);
export const FORM_REASONS = Object.freeze({
  wfh: "WFH",
  university_holiday: "University Holiday",
  other: "Other",
});
export const FORM_SOURCES = Object.freeze(["automatic", "manual"]);
export const FORM_IMPORT_MAX_ROWS = 1000;
export const SUBMITTED_BY_MAX = 120;
export const REASON_OTHER_MAX = 300;
const THUMB_SIZE = 360;
const LINKS = "institute_form_links";
const RESPONSES = "form_responses";
const ACTIVE = { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] };

// ---- links -----------------------------------------------------------------

export function formSlug(name) {
  const slug = String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "institute";
}

export function formPath(name, token) {
  return `/form/${formSlug(name)}/${token}`;
}

export function newFormToken() {
  return crypto.randomBytes(18).toString("base64url");
}

export function isFormToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

// Every active institute with its form link, creating the links that do not
// exist yet (a new institute gets its link the first time the list is read).
export async function ensureFormLinks(db) {
  const [colleges, links] = await Promise.all([
    db.collection("colleges").find(ACTIVE).limit(1000).toArray(),
    db.collection(LINKS).find({}).limit(5000).toArray(),
  ]);
  const byCollege = new Map(links.map((link) => [String(link.college_id), link]));
  for (const college of colleges) {
    const collegeId = String(college._id);
    if (byCollege.has(collegeId)) continue;
    const link = createDocument({ college_id: collegeId, token: newFormToken(), created_at: new Date() });
    try {
      await db.collection(LINKS).insertOne(link);
      byCollege.set(collegeId, link);
    } catch (error) {
      // Another admin's page created it at the same moment: use theirs.
      if (error?.code !== 11000) throw error;
      const existing = await db.collection(LINKS).findOne({ college_id: collegeId });
      if (existing) byCollege.set(collegeId, existing);
    }
  }
  return colleges
    .map((college) => {
      const link = byCollege.get(String(college._id));
      if (!link) return null;
      return {
        college_id: String(college._id),
        name: college.name,
        location: college.location || "",
        token: link.token,
        path: formPath(college.name, link.token),
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

// The link and its institute, or null when the token is unknown or the
// institute has been deleted.
export async function findFormLink(db, token) {
  if (!isFormToken(token)) return null;
  const link = await db.collection(LINKS).findOne({ token });
  if (!link) return null;
  const college = await db.collection("colleges").findOne({
    $and: [{ _id: { $in: [String(link.college_id)] } }, ACTIVE],
  });
  return college ? { link, college } : null;
}

// ---- dates -----------------------------------------------------------------

// The form's date: today when none is given, any earlier real date, never a
// future one.
export function resolveFormDate(value, today) {
  const date = value === undefined || value === null || value === "" ? today : String(value);
  if (!isValidDateKey(date)) return { error: "This date is not a real calendar date." };
  if (date > today) return { error: "This date has not come yet. Open today's form or an earlier day's." };
  if (date < FORM_EARLIEST_DATE) return { error: "This date is too far in the past." };
  return { date };
}

// ---- answers ---------------------------------------------------------------

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// The answers sent by the public form, with one message per unanswered or
// invalid question (keyed like the form's fields).
export function readFormAnswers(body = {}) {
  const errors = {};
  const status = cleanText(body.status).toLowerCase();
  if (!FORM_STATUSES.includes(status)) errors.status = "This is a required question";

  const submittedBy = cleanText(body.submitted_by);
  if (!submittedBy) errors.submitted_by = "This is a required question";
  else if (submittedBy.length > SUBMITTED_BY_MAX) errors.submitted_by = `Use ${SUBMITTED_BY_MAX} characters or fewer`;

  let reason = null;
  let reasonOther = "";
  if (status === "no") {
    const given = cleanText(body.reason).toLowerCase();
    if (!Object.hasOwn(FORM_REASONS, given)) {
      errors.reason = "This is a required question";
    } else {
      reason = given;
      if (reason === "other") {
        reasonOther = cleanText(body.reason_other);
        if (!reasonOther) errors.reason = "Please type the other reason";
        else if (reasonOther.length > REASON_OTHER_MAX) errors.reason = `Use ${REASON_OTHER_MAX} characters or fewer`;
      }
    }
  }
  return { status, submittedBy, reason, reasonOther, errors };
}

// The saved photos the person kept while editing, as a JSON list of photo
// ids; null when the field is malformed.
export function readKeptPhotoIds(value) {
  if (value === undefined || value === null || value === "") return [];
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id))
      .slice(0, 20);
  } catch {
    return null;
  }
}

export function reasonLabel(reason, reasonOther = "") {
  if (!reason) return "";
  if (reason === "other") return reasonOther ? `Other: ${reasonOther}` : "Other";
  return FORM_REASONS[reason] || "";
}

// ---- photos ----------------------------------------------------------------

export function formPhotoKey(collegeId, date, photoId, variant = "full") {
  const safeCollege = String(collegeId).replace(/[^A-Za-z0-9_-]/g, "");
  return `forms/${safeCollege}/${date}/${photoId}${variant === "thumb" ? "-thumb" : ""}.jpg`;
}

// Saves one uploaded photo (upright, at most 3072 px, JPEG) and its preview.
export async function storeFormPhoto({ buffer, collegeId, date }) {
  let normalized;
  let thumb;
  try {
    normalized = await normalizeInstructorImage(buffer);
    thumb = await sharp(normalized.buffer)
      .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
  } catch (error) {
    return {
      status: 422,
      error: `One of the photos could not be read (${error?.message || "unsupported image"}). Choose a clear JPG or PNG photo.`,
    };
  }
  const id = crypto.randomBytes(9).toString("base64url");
  const key = formPhotoKey(collegeId, date, id);
  const thumbKey = formPhotoKey(collegeId, date, id, "thumb");
  const metadata = { college_id: collegeId, form_date: date, kind: "form" };
  const stored = await uploadPhoto({ key, body: normalized.buffer, mimeType: "image/jpeg", metadata });
  if (!stored.stored) {
    return { status: 502, error: "The photos could not be saved right now. Please press Submit again." };
  }
  const storedThumb = await uploadPhoto({ key: thumbKey, body: thumb, mimeType: "image/jpeg", metadata });
  if (!storedThumb.stored) {
    await deletePhoto(key);
    return { status: 502, error: "The photos could not be saved right now. Please press Submit again." };
  }
  return {
    photo: {
      id,
      key,
      thumb_key: thumbKey,
      width: normalized.width,
      height: normalized.height,
      bytes: normalized.buffer.length,
      uploaded_at: new Date(),
    },
  };
}

export async function removeFormPhotos(photos = []) {
  for (const photo of photos) {
    if (photo?.key) await deletePhoto(photo.key);
    if (photo?.thumb_key) await deletePhoto(photo.thumb_key);
    await removePersonCrops(photo?.people);
  }
}

// ---- the people in each photo ---------------------------------------------
//
// The submitter's browser finds each person in a group photo, cuts them out
// and reads the printed name labels (no face recognition, no work here). The
// form sends the small cut-outs with the instructor chosen for each, and they
// are kept on the photo as `people: [{ id, crop_key, instructor_id, name,
// employee_id, source, box }]`.

export const FORM_MAX_PEOPLE_PER_PHOTO = 60;
export const FORM_MAX_CROPS = 150;
export const FORM_MAX_CROP_BYTES = Math.floor(1.5 * 1024 * 1024);
const PERSON_SOURCES = new Set(["label", "manual", "none"]);

export async function removePersonCrops(people = []) {
  for (const person of Array.isArray(people) ? people : []) {
    if (person?.crop_key) await deletePhoto(person.crop_key);
  }
}

// The institute's instructors, for the form's name list.
export async function formInstructors(db, collegeId) {
  const rows = await db.collection("instructors")
    .find({ $and: [{ college_id: String(collegeId) }, ACTIVE] })
    .limit(3000)
    .toArray();
  return rows
    .map((row) => ({ id: String(row._id), name: String(row.name || ""), employee_id: row.employee_id ? String(row.employee_id) : "" }))
    .filter((row) => row.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function clampFraction(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

function readBox(value) {
  if (!value || typeof value !== "object") return null;
  const box = {
    left: clampFraction(value.left),
    top: clampFraction(value.top),
    width: clampFraction(value.width),
    height: clampFraction(value.height),
  };
  return box.width > 0 && box.height > 0 ? box : null;
}

// The people the form sent, as a JSON list of
//   { photo: "new:<n>" | "<saved photo id>", people: [{ id?, crop?, instructor_id, source, box }] }
// where `crop` is the position of that person's cut-out among the uploaded
// crops and `id` keeps a person already saved. Returns null when malformed.
export function readPeoplePlan(value) {
  if (value === undefined || value === null || value === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > FORM_MAX_PHOTOS * 2) return null;
  const plan = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || typeof entry.photo !== "string" || !Array.isArray(entry.people)) return null;
    if (!/^(new:\d{1,2}|[A-Za-z0-9_-]{1,64})$/.test(entry.photo)) return null;
    if (entry.people.length > FORM_MAX_PEOPLE_PER_PHOTO) return null;
    const people = [];
    for (const person of entry.people) {
      if (!person || typeof person !== "object") return null;
      const id = typeof person.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(person.id) ? person.id : null;
      const crop = Number.isSafeInteger(person.crop) && person.crop >= 0 && person.crop < FORM_MAX_CROPS ? person.crop : null;
      if (!id && crop === null) return null;
      const instructorId = typeof person.instructor_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(person.instructor_id)
        ? person.instructor_id
        : null;
      // The name and id printed on the person's label, kept as they are when
      // the person is not in the institute's instructor list.
      const labelName = cleanText(person.label_name).slice(0, SUBMITTED_BY_MAX) || null;
      const labelId = /^[A-Za-z0-9-]{3,40}$/.test(cleanText(person.label_id)) ? cleanText(person.label_id).toUpperCase() : null;
      people.push({
        id,
        crop,
        instructorId,
        labelName,
        labelId,
        source: PERSON_SOURCES.has(person.source) ? person.source : (instructorId ? "manual" : "none"),
        box: readBox(person.box),
      });
    }
    plan.push({ photo: entry.photo, people });
  }
  return plan;
}

function personKey(collegeId, date, photoId, personId) {
  return formPhotoKey(collegeId, date, `${photoId}-${personId}`);
}

// The people for one photo after an edit: saved people kept (with any new
// name), new cut-outs stored, and those no longer listed returned as removed.
// `crops` are the uploaded cut-out files; `roster` maps instructor id to the
// institute's instructor. Throws { status, message } when a crop is unusable.
export async function buildPhotoPeople({ entry, existing = [], crops, roster, collegeId, date, photoId }) {
  const saved = new Map((Array.isArray(existing) ? existing : []).map((person) => [person.id, person]));
  const people = [];
  const stored = [];
  for (const planned of entry.people) {
    const instructor = planned.instructorId ? roster.get(planned.instructorId) : null;
    const printed = !instructor && planned.source === "label" && (planned.labelName || planned.labelId);
    const named = instructor
      ? { instructor_id: instructor.id, name: instructor.name, employee_id: instructor.employee_id || null }
      : printed
        ? { instructor_id: null, name: planned.labelName || planned.labelId, employee_id: planned.labelId }
        : { instructor_id: null, name: null, employee_id: null };
    const source = instructor ? (planned.source === "none" ? "manual" : planned.source) : (printed ? "label" : "none");
    if (planned.id && saved.has(planned.id)) {
      const person = saved.get(planned.id);
      saved.delete(planned.id);
      people.push({ ...person, ...named, source, box: planned.box ?? person.box ?? null });
      continue;
    }
    const file = planned.crop === null ? null : crops[planned.crop];
    if (!file) continue;
    const personId = crypto.randomBytes(6).toString("base64url");
    const key = personKey(collegeId, date, photoId, personId);
    const upload = await uploadPhoto({
      key,
      body: file.buffer,
      mimeType: file.mimeType,
      metadata: { college_id: String(collegeId), form_date: date, kind: "form_person" },
    });
    if (!upload.stored) {
      await removePersonCrops(stored);
      throw Object.assign(new Error("The people's pictures could not be saved right now. Please press Submit again."), { status: 502 });
    }
    const person = { id: personId, crop_key: key, ...named, source, box: planned.box };
    stored.push(person);
    people.push(person);
  }
  return { people, stored, removed: [...saved.values()] };
}

// ---- reading responses -----------------------------------------------------

export async function serializeFormResponse(doc, { collegeName, expiresIn = 3600 } = {}) {
  const photos = await Promise.all((doc.photos || []).map(async (photo) => ({
    id: photo.id,
    url: await getPhotoUrl(photo.key, { expiresIn }),
    thumb_url: photo.thumb_key ? await getPhotoUrl(photo.thumb_key, { expiresIn }) : null,
    people: await Promise.all((Array.isArray(photo.people) ? photo.people : []).map(async (person) => ({
      id: person.id,
      instructor_id: person.instructor_id || null,
      name: person.name || null,
      employee_id: person.employee_id || null,
      source: PERSON_SOURCES.has(person.source) ? person.source : "none",
      box: person.box || null,
      crop_url: person.crop_key ? await getPhotoUrl(person.crop_key, { expiresIn }) : null,
    }))),
  })));
  return {
    _id: String(doc._id),
    college_id: String(doc.college_id),
    college_name: collegeName ?? doc.college_name ?? "",
    form_date: doc.form_date,
    status: doc.status,
    submitted_by: doc.submitted_by || "",
    reason: doc.reason || null,
    reason_other: doc.reason_other || "",
    reason_label: reasonLabel(doc.reason, doc.reason_other),
    photos,
    photo_links: Array.isArray(doc.photo_links) ? doc.photo_links : [],
    source: FORM_SOURCES.includes(doc.source) ? doc.source : "automatic",
    submitted_at: doc.submitted_at || null,
    updated_at: doc.updated_at || null,
    edit_count: Number.isSafeInteger(doc.edit_count) ? doc.edit_count : 0,
  };
}

export async function findFormResponse(db, collegeId, date) {
  return db.collection(RESPONSES).findOne({ college_id: String(collegeId), form_date: date });
}

// Responses between two dates (inclusive), newest first.
export async function listFormResponses(db, { from, to } = {}) {
  const range = {};
  if (isValidDateKey(from)) range.$gte = from;
  if (isValidDateKey(to)) range.$lte = to;
  const filter = Object.keys(range).length ? { form_date: range } : {};
  return db.collection(RESPONSES).find(filter).sort({ form_date: -1 }).limit(5000).toArray();
}

export async function activeCollegeNames(db) {
  const colleges = await db.collection("colleges").find(ACTIVE).limit(1000).toArray();
  return new Map(colleges.map((college) => [String(college._id), college.name]));
}

// ---- importing an existing sheet ------------------------------------------

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function dateKey(year, month, day) {
  const key = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isValidDateKey(key) ? key : null;
}

// A sheet date as YYYY-MM-DD. Accepts 2026-11-23, 23-11-2026, 23/11/2026,
// 23.11.2026 (day first, as Indian sheets write it) and 23 Nov 2026, with or
// without a time after it.
export function parseImportDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[ T])/);
  if (match) return dateKey(match[1], match[2], match[3]);
  match = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:$|[ ,T])/);
  if (match) return dateKey(match[3], match[2], match[1]);
  match = text.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{4})(?:$|[ ,T])/);
  if (match) {
    const name = match[2].toLowerCase();
    const month = MONTHS[name] ?? MONTHS[name.slice(0, 4)] ?? MONTHS[name.slice(0, 3)];
    return month ? dateKey(match[3], month, match[1]) : null;
  }
  return null;
}

// A sheet timestamp ("23/11/2026 10:04:31") as a moment in India time.
export function parseImportTimestamp(value) {
  const text = cleanText(value);
  const date = parseImportDate(text);
  if (!date) return null;
  const time = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*$/);
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (time) {
    hours = Number(time[1]);
    minutes = Number(time[2]);
    seconds = Number(time[3] || 0);
    const meridiem = time[4]?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59 || seconds > 59) return null;
  }
  const stamp = new Date(`${date}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}+05:30`);
  return Number.isNaN(stamp.getTime()) ? null : stamp;
}

export function normalizeInstituteName(name) {
  return cleanText(name).toLowerCase();
}

function importStatus(value) {
  const text = cleanText(value).toLowerCase();
  if (["yes", "y", "submitted", "true"].includes(text)) return "yes";
  if (["no", "n", "not submitted", "false"].includes(text)) return "no";
  return null;
}

function importReason(value) {
  const text = cleanText(value);
  if (!text) return { reason: null, reasonOther: "" };
  const lower = text.toLowerCase();
  if (lower === "wfh" || lower === "work from home") return { reason: "wfh", reasonOther: "" };
  if (lower === "university holiday" || lower === "holiday") return { reason: "university_holiday", reasonOther: "" };
  return { reason: "other", reasonOther: text.replace(/^other\s*:\s*/i, "").slice(0, REASON_OTHER_MAX) };
}

export function importPhotoLinks(value) {
  return [...new Set(String(value ?? "")
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => /^https?:\/\/[^\s]{3,2000}$/i.test(part)))]
    .slice(0, FORM_MAX_PHOTOS);
}

// One imported sheet row as a "manual" response, or the reason it is skipped.
// `collegesByName` maps a lower-cased institute name to its active institutes.
export function buildImportedResponse(row, { collegesByName, today, importedBy = null, now = new Date() }) {
  const date = parseImportDate(row?.date);
  if (!date) return { error: "The date is missing or not in a known format (use DD-MM-YYYY)." };
  const checked = resolveFormDate(date, today);
  if (checked.error) return { error: checked.error };

  const status = importStatus(row?.status);
  if (!status) return { error: "Photo Submission Status must be Yes or No." };

  const universityName = cleanText(row?.university);
  if (!universityName) return { error: "University Name is missing." };
  const matches = collegesByName.get(normalizeInstituteName(universityName)) || [];
  if (!matches.length) return { error: `No institute is named "${universityName.slice(0, 120)}".` };
  if (matches.length > 1) return { error: `More than one institute is named "${universityName.slice(0, 120)}".` };
  const college = matches[0];

  const submittedBy = cleanText(row?.submitted_by).slice(0, SUBMITTED_BY_MAX);
  if (!submittedBy) return { error: "Submitted By is missing." };

  const { reason, reasonOther } = status === "no" ? importReason(row?.reason) : { reason: null, reasonOther: "" };
  const submittedAt = parseImportTimestamp(row?.timestamp) || now;
  return {
    doc: createDocument({
      college_id: String(college._id),
      college_name: college.name,
      form_date: checked.date,
      status,
      submitted_by: submittedBy,
      reason,
      reason_other: reasonOther,
      photos: [],
      photo_links: status === "yes" ? importPhotoLinks(row?.picture) : [],
      source: "manual",
      submitted_at: submittedAt,
      updated_at: now,
      edit_count: 0,
      imported_by: importedBy,
      imported_at: now,
    }),
  };
}

export async function importFormResponses(db, rows, { today, importedBy = null, now = new Date() }) {
  const colleges = await db.collection("colleges").find(ACTIVE).limit(1000).toArray();
  const collegesByName = new Map();
  for (const college of colleges) {
    const key = normalizeInstituteName(college.name);
    collegesByName.set(key, [...(collegesByName.get(key) || []), college]);
  }
  let created = 0;
  const skipped = [];
  for (const [index, row] of rows.entries()) {
    const rowNumber = Number.isSafeInteger(row?.row) ? row.row : index + 2;
    const built = buildImportedResponse(row, { collegesByName, today, importedBy, now });
    if (built.error) {
      skipped.push({ row: rowNumber, reason: built.error });
      continue;
    }
    try {
      await db.collection(RESPONSES).insertOne(built.doc);
      created += 1;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      skipped.push({ row: rowNumber, reason: "This institute already has a response for this date." });
    }
  }
  return { created, skipped };
}
