import sharp from "sharp";
import { z } from "zod";
import { detectImageMimeType } from "../imageValidation.js";
import { normalizeInstructorImage } from "../imageProcessor.js";
import { checkFaceQuality, isFaceRecognitionConfigured } from "./faceRecognition.js";
import { enrollReferencePhoto } from "./referencePhotos.js";
import {
  fetchPublicUrl,
  isGoogleHost,
  parsePublicUrl,
  RemoteFetchError,
  toDirectFileUrl,
  toSheetCsvUrl,
} from "./remoteFetch.js";

/**
 * Adding instructors in bulk from a CSV file or a Google Sheet.
 *
 * The browser reads the file and sends the rows here in small batches, twice:
 * once to be checked (preview) and once, for the rows that passed, to be
 * added (commit). Every rule is applied on both passes, since the roster can
 * change between them. A row is either added whole, photograph included, or
 * reported with the reasons it was not; nothing half-valid reaches the roster.
 */

/** The roles the Instructors form offers, in its upper-case stored form. */
export const IMPORT_ROLES = ["INSTRUCTOR", "CENTRAL_INSTRUCTOR", "MENTOR", "OTHER"];

/** Rows per preview request: each may download and check a photograph. */
export const MAX_PREVIEW_ROWS = 25;
/** Rows per commit request: each also stores and indexes a photograph. */
export const MAX_COMMIT_ROWS = 5;
/** Photographs fetched and checked at once within one request. */
const PHOTO_CONCURRENCY = 5;
const MAX_SHEET_BYTES = 2 * 1024 * 1024;

const emailSchema = z.string().email().max(254);

function activeFilter(extra = {}) {
  return {
    $and: [
      extra,
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
    ],
  };
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function comparable(value) {
  return text(value).replace(/\s+/g, " ").toLowerCase();
}

/**
 * INSTRUCTOR, CENTRAL_INSTRUCTOR, MENTOR or OTHER from however a sheet spells
 * it: "Central Instructor", "central-instructor" and "CENTRAL_INSTRUCTOR" are
 * the same role. Anything else is null.
 */
export function normalizeImportRole(value) {
  const key = text(value).toUpperCase().replace(/[\s-]+/g, "_");
  return IMPORT_ROLES.includes(key) ? key : null;
}

/** MALE or FEMALE from M, Male, F, Female in any case; anything else is null. */
export function normalizeImportGender(value) {
  const key = text(value).toUpperCase();
  if (key === "M" || key === "MALE") return "MALE";
  if (key === "F" || key === "FEMALE") return "FEMALE";
  return null;
}

/**
 * The institute a row names, by its id or by its name ignoring case and
 * spacing. Two institutes can share a name in different cities, and guessing
 * between them would put someone on the wrong campus, so that is an error
 * that asks for the id instead.
 */
export function matchCollege(value, colleges) {
  const wanted = text(value);
  if (!wanted) return { error: "Institute is missing" };
  const byId = colleges.find((college) => String(college._id) === wanted);
  if (byId) return { college: byId };
  const byName = colleges.filter((college) => comparable(college.name) === comparable(wanted));
  if (byName.length === 1) return { college: byName[0] };
  if (byName.length > 1) {
    return { error: `Institute "${wanted}" matches ${byName.length} institutes; use its institute ID instead` };
  }
  return { error: `Institute "${wanted}" was not found` };
}

/**
 * Checks one row's fields and returns them in stored form.
 *
 * Errors are sentences an admin can act on, naming the value that was wrong,
 * and every problem in the row is reported at once rather than one per try.
 */
export function validateImportFields(raw, colleges) {
  const errors = [];
  const name = text(raw?.name).replace(/\s+/g, " ");
  if (!name) errors.push("Name is missing");
  else if (name.length < 2) errors.push("Name must be at least 2 characters");
  else if (name.length > 120) errors.push("Name is longer than 120 characters");

  const email = text(raw?.email).toLowerCase();
  if (!email) errors.push("Email is missing");
  else if (!emailSchema.safeParse(email).success) errors.push(`Email "${text(raw.email)}" is not a valid address`);

  const genderText = text(raw?.gender);
  const gender = normalizeImportGender(genderText);
  if (!genderText) errors.push("Gender is missing");
  else if (!gender) errors.push(`Gender "${genderText}" must be Male or Female`);

  const roleText = text(raw?.role);
  const role = normalizeImportRole(roleText);
  if (!roleText) errors.push("Role is missing");
  else if (!role) errors.push(`Role "${roleText}" must be Instructor, Central Instructor, Mentor or Other`);

  const institute = matchCollege(raw?.institute, colleges);
  if (institute.error) errors.push(institute.error);

  const employeeId = text(raw?.employee_id);
  if (employeeId.length > 50) errors.push("Employee ID is longer than 50 characters");

  const phone = text(raw?.phone_no);
  if (phone) {
    const digits = phone.replace(/\D/g, "").length;
    if (!/^[+()\-\s\d]*$/.test(phone) || phone.length > 30 || digits < 7 || digits > 15) {
      errors.push(`Phone "${phone}" is not a valid phone number`);
    }
  }

  const photoUrl = text(raw?.photo_url);
  if (!photoUrl) {
    errors.push("Photo link is missing");
  } else {
    try {
      parsePublicUrl(photoUrl);
    } catch (error) {
      errors.push(`Photo link: ${error.message}`);
    }
  }

  if (errors.length) return { errors };
  return {
    errors,
    value: {
      name,
      email,
      ...(employeeId ? { employee_id: employeeId } : {}),
      role,
      // What the tables display, as the add form sends it.
      instructor_role: role,
      gender,
      college_id: String(institute.college._id),
      ...(phone ? { phone_no: phone } : {}),
      photo_url: photoUrl,
    },
    collegeName: institute.college.name || "",
  };
}

/**
 * The emails and employee ids among `values` that the roster already holds.
 *
 * An employee id is taken even by a removed instructor, matching the create
 * guard and the unique index; an email only by someone still active, since a
 * person who left and returns keeps their address.
 */
export async function findExistingInstructors(db, values) {
  const emails = [...new Set(values.map((value) => value.email).filter(Boolean))];
  const employeeIds = [...new Set(values.map((value) => value.employee_id).filter(Boolean))];
  const clauses = [];
  if (emails.length) clauses.push({ email: { $in: emails } });
  if (employeeIds.length) clauses.push({ employee_id: { $in: employeeIds } });
  if (!clauses.length) return { emails: new Set(), employeeIds: new Set() };

  const rows = await db.collection("instructors")
    .find({ $or: clauses }, { projection: { email: 1, employee_id: 1, deleted_at: 1 } })
    .toArray();
  return {
    emails: new Set(rows.filter((row) => !row.deleted_at && row.email).map((row) => String(row.email).toLowerCase())),
    employeeIds: new Set(rows.filter((row) => row.employee_id).map((row) => String(row.employee_id))),
  };
}

function duplicateErrors(value, existing) {
  const errors = [];
  if (existing.emails.has(value.email)) {
    errors.push(`An instructor with email ${value.email} already exists`);
  }
  if (value.employee_id && existing.employeeIds.has(value.employee_id)) {
    errors.push(`Employee ID ${value.employee_id} already exists`);
  }
  return errors;
}

/**
 * Downloads, checks and normalizes the photograph a row links to.
 *
 * Throws an Error whose message is the reason shown against the row. A link
 * that opens a web page instead of an image is the usual mistake - a Drive
 * file not shared publicly returns the sign-in page - so it is named as such.
 */
export async function loadImportPhoto(link, { fetcher = fetchPublicUrl } = {}) {
  let response;
  try {
    response = await fetcher(toDirectFileUrl(link));
  } catch (error) {
    throw new Error(`Photo link: ${error instanceof RemoteFetchError ? error.message : "could not be opened"}`);
  }
  if (!detectImageMimeType(response.buffer)) {
    if (String(response.contentType || "").includes("html")) {
      throw new Error("Photo link opens a web page, not an image. Share the file publicly or use a direct image link");
    }
    throw new Error("Photo link is not a JPEG, PNG or WebP image");
  }
  try {
    return await normalizeInstructorImage(response.buffer);
  } catch (error) {
    throw new Error(`Photo: ${error.message}`);
  }
}

/** A small square preview, sent back so the admin can see whose face it is. */
export async function photoThumbnail(buffer) {
  const small = await sharp(buffer)
    .resize(96, 96, { fit: "cover", position: "attention" })
    .jpeg({ quality: 70 })
    .toBuffer();
  return `data:image/jpeg;base64,${small.toString("base64")}`;
}

/**
 * Fetches and checks one row's photograph, including the face check when
 * recognition is configured. Returns { normalized, quality } or { error }.
 */
async function checkPhoto(link, deps) {
  let normalized;
  try {
    normalized = await loadImportPhoto(link, deps);
  } catch (error) {
    return { error: error.message };
  }
  if (!deps.faceConfigured) return { normalized, quality: null };
  const quality = await deps.checkQuality(normalized.buffer);
  if (!quality.ok) return { error: `Photo: ${quality.message}` };
  return { normalized, quality: quality.quality };
}

async function mapWithConcurrency(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function resolveDeps(deps = {}) {
  return {
    fetcher: deps.fetcher || fetchPublicUrl,
    checkQuality: deps.checkQuality || checkFaceQuality,
    faceConfigured: deps.faceConfigured ?? isFaceRecognitionConfigured(),
    // Passed in by the route, which owns the guarded create; importing it
    // from there would make the two modules import each other.
    createInstructor: deps.createInstructor,
    enrollPhoto: deps.enrollPhoto || enrollReferencePhoto,
  };
}

async function loadColleges(db) {
  return db.collection("colleges")
    .find(activeFilter(), { projection: { name: 1, location: 1 } })
    .toArray();
}

/**
 * Field checks, then duplicates against the roster and within this batch,
 * then the photograph for whatever is still valid. Returns one result per row
 * in the order given; `row` is the sheet row number the browser sent.
 */
async function checkRows(db, rows, deps) {
  const colleges = await loadColleges(db);
  const results = rows.map((raw) => {
    const checked = validateImportFields(raw, colleges);
    return { row: raw?.row ?? null, errors: checked.errors, value: checked.value, collegeName: checked.collegeName };
  });

  const valid = results.filter((result) => result.value);
  const existing = await findExistingInstructors(db, valid.map((result) => result.value));
  const seenEmails = new Set();
  const seenIds = new Set();
  for (const result of valid) {
    const errors = duplicateErrors(result.value, existing);
    // The browser already removes repeats across the whole file; this only
    // guards a batch sent without that.
    if (seenEmails.has(result.value.email)) errors.push(`Email ${result.value.email} appears more than once`);
    if (result.value.employee_id && seenIds.has(result.value.employee_id)) {
      errors.push(`Employee ID ${result.value.employee_id} appears more than once`);
    }
    seenEmails.add(result.value.email);
    if (result.value.employee_id) seenIds.add(result.value.employee_id);
    if (errors.length) {
      result.errors = errors;
      result.value = undefined;
    }
  }

  await mapWithConcurrency(results, PHOTO_CONCURRENCY, async (result) => {
    if (!result.value) return;
    const photo = await checkPhoto(result.value.photo_url, deps);
    if (photo.error) {
      result.errors = [photo.error];
      result.value = undefined;
      return;
    }
    result.photo = photo;
  });
  return results;
}

/**
 * Checks a batch without writing anything. A passing row comes back in stored
 * form with a thumbnail of its photograph; a failing one with its reasons.
 */
export async function previewImportRows(db, rows, deps = {}) {
  const resolved = resolveDeps(deps);
  const results = await checkRows(db, rows, resolved);
  return Promise.all(results.map(async (result) => {
    if (!result.value) return { row: result.row, ok: false, errors: result.errors };
    return {
      row: result.row,
      ok: true,
      value: { ...result.value, institute: result.collegeName },
      thumbnail: await photoThumbnail(result.photo.normalized.buffer).catch(() => null),
    };
  }));
}

/**
 * Checks a batch again and adds every row that still passes, one at a time.
 *
 * The photograph is fetched and checked before the instructor is created, so
 * a bad photo adds nobody. Storing and indexing it happen after, since a face
 * is indexed against the new id; if that step fails the instructor is kept and
 * the row says so, the same as the add form, and the photo can be added from
 * Edit. Rows are created in turn rather than together because each creation
 * takes a transaction on its institute's record.
 */
export async function commitImportRows(db, rows, deps = {}) {
  const resolved = resolveDeps(deps);
  const results = await checkRows(db, rows, resolved);
  const outcomes = [];
  for (const result of results) {
    if (!result.value) {
      outcomes.push({ row: result.row, ok: false, errors: result.errors });
      continue;
    }
    const { photo_url: _photoUrl, ...fields } = result.value;
    let created;
    try {
      created = await resolved.createInstructor(db, fields);
    } catch (error) {
      if (error?.code === 11000) {
        outcomes.push({ row: result.row, ok: false, errors: ["Employee ID already exists"] });
        continue;
      }
      throw error;
    }
    if (created.outcome === "college_not_found") {
      outcomes.push({ row: result.row, ok: false, errors: ["The institute was removed while importing"] });
      continue;
    }
    if (created.outcome === "duplicate_employee_id") {
      outcomes.push({ row: result.row, ok: false, errors: [`Employee ID ${fields.employee_id} already exists`] });
      continue;
    }

    const outcome = { row: result.row, ok: true, id: created.instructor._id, name: fields.name, photo_enrolled: false };
    if (resolved.faceConfigured) {
      const enrolled = await resolved.enrollPhoto(db, created.instructor, result.photo.normalized, {
        mode: "add",
        checkedQuality: result.photo.quality,
      });
      if (enrolled.ok) outcome.photo_enrolled = true;
      else outcome.warning = `Added, but the photo was not enrolled: ${enrolled.detail}`;
    } else {
      outcome.warning = "Added, but the photo was not enrolled: face recognition is not configured";
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * Downloads a Google Sheet as CSV text. The sheet must be shared as "anyone
 * with the link can view"; otherwise Google answers with its sign-in page,
 * which is reported as exactly that.
 */
export async function fetchSheetCsv(link, { fetcher = fetchPublicUrl } = {}) {
  const csvUrl = toSheetCsvUrl(link);
  if (!csvUrl) throw new RemoteFetchError("Paste a Google Sheets link (docs.google.com/spreadsheets/...)");
  const response = await fetcher(csvUrl, {
    maxBytes: MAX_SHEET_BYTES,
    allowHost: isGoogleHost,
  });
  if (String(response.contentType || "").includes("html")) {
    throw new RemoteFetchError(
      "The sheet is not public. In Google Sheets choose Share, then \"Anyone with the link\" can view, and try again"
    );
  }
  return response.buffer.toString("utf8");
}
