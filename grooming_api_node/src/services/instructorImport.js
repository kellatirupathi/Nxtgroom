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
export const IMPORT_ROLES = ["INSTRUCTOR", "CENTRAL_INSTRUCTOR", "CENTRAL_TEAM", "MENTOR", "OTHER"];

/** "CENTRAL_TEAM" as "Central Team", for messages. */
function roleWords(role) {
  return role.toLowerCase().split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

const ROLE_CHOICES = `${IMPORT_ROLES.slice(0, -1).map(roleWords).join(", ")} or ${roleWords(IMPORT_ROLES.at(-1))}`;

/**
 * What separates two values typed into one cell, per field.
 *
 * A cell sometimes holds two emails or two phone numbers; the first is the
 * one used. The separators differ by field because a comma is part of a name
 * ("Nair, Anjali") or an institute, and a slash is part of every link, so
 * those are only split where they cannot belong to a single value.
 */
const MULTI_VALUE_SEPARATORS = {
  name: /[\n;|]/,
  email: /[\s,;/|]+/,
  gender: /[\s,;/|]+/,
  role: /[\n,;/|]/,
  institute: /[\n;|]/,
  employee_id: /[\s,;/|]+/,
  phone_no: /[\n,;/|]/,
  photo_url: /[\s,;|]+/,
};

/** The first of several values in one cell, or the whole cell when there is one. */
export function firstValue(field, value) {
  const whole = text(value);
  const separator = MULTI_VALUE_SEPARATORS[field];
  if (!whole || !separator) return whole;
  return whole.split(separator).map((part) => part.trim()).find(Boolean) ?? "";
}

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

/**
 * A value reduced to lower-case letters and digits, so case, spacing and
 * punctuation never decide a match: "Hyderabad – Kondapur Campus" and
 * "hyderabad-kondapur campus" are the same institute.
 */
function comparable(value) {
  return text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * One of IMPORT_ROLES from however a sheet spells it: "Central Instructor",
 * "central-instructor", "CENTRAL_INSTRUCTOR" and "Central Team." all match.
 * Anything else is null.
 */
export function normalizeImportRole(value) {
  const key = comparable(value);
  return IMPORT_ROLES.find((role) => comparable(role) === key) ?? null;
}

/**
 * MALE or FEMALE from M, Male, Man, F, Female or Woman in any case;
 * anything else is null.
 */
export function normalizeImportGender(value) {
  const key = comparable(value);
  if (["m", "male", "man"].includes(key)) return "MALE";
  if (["f", "female", "woman"].includes(key)) return "FEMALE";
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

/** Why a photo link cannot be used, or null when it can. */
export function photoLinkError(photoUrl) {
  if (!photoUrl) return "Photo link is missing";
  try {
    parsePublicUrl(photoUrl);
    return null;
  } catch (error) {
    return `Photo link: ${error.message}`;
  }
}

/**
 * Checks one row's fields and returns them in stored form.
 *
 * Errors are sentences an admin can act on, naming the value that was wrong,
 * and every problem in the row is reported at once rather than one per try.
 *
 * `keptRole` is the role on the instructor's record, accepted as it is
 * whether the sheet left it blank or repeated it.
 *
 * `requirePhoto: false` leaves the photo link out of the errors and returns
 * its problem as `photoError` instead, for the import, which only needs a
 * photo when the instructor it creates or updates has none. `keys` carries
 * the email and Employee ID even for a row that failed, so an existing
 * instructor can still be matched.
 */
export function validateImportFields(raw, colleges, { requirePhoto = true, keptRole = "" } = {}) {
  const errors = [];
  const cell = (field) => firstValue(field, raw?.[field]);
  const name = cell("name").replace(/\s+/g, " ");
  if (!name) errors.push("Name is missing");
  else if (name.length < 2) errors.push("Name must be at least 2 characters");
  else if (name.length > 120) errors.push("Name is longer than 120 characters");

  const emailText = cell("email");
  const email = emailText.toLowerCase();
  if (!email) errors.push("Email is missing");
  else if (!emailSchema.safeParse(email).success) errors.push(`Email "${emailText}" is not a valid address`);

  const genderText = cell("gender");
  const gender = normalizeImportGender(genderText);
  if (!genderText) errors.push("Gender is missing");
  else if (!gender) errors.push(`Gender "${genderText}" must be Male or Female`);

  const roleText = cell("role");
  // The role already on record is taken as it is, even one the import would
  // not accept as a new role, such as a synced "Trainee".
  const role = normalizeImportRole(roleText)
    ?? (keptRole && comparable(roleText) === comparable(keptRole) ? keptRole : null);
  if (!roleText) errors.push("Role is missing");
  else if (!role) errors.push(`Role "${roleText}" must be ${ROLE_CHOICES}`);

  const institute = matchCollege(cell("institute"), colleges);
  if (institute.error) errors.push(institute.error);

  // Required here although optional on a synced record: an imported
  // instructor is added by hand, as through the add form, which requires it.
  const employeeId = cell("employee_id");
  if (!employeeId) errors.push("Employee ID is missing");
  else if (employeeId.length > 50) errors.push("Employee ID is longer than 50 characters");

  const phone = cell("phone_no");
  if (phone) {
    const digits = phone.replace(/\D/g, "").length;
    if (!/^[+()\-\s\d]*$/.test(phone) || phone.length > 30 || digits < 7 || digits > 15) {
      errors.push(`Phone "${phone}" is not a valid phone number`);
    }
  }

  const photoUrl = cell("photo_url");
  const photoError = photoLinkError(photoUrl);
  if (requirePhoto && photoError) errors.push(photoError);

  const keys = { email, employee_id: employeeId };
  if (errors.length) return { errors, keys, photoError };
  return {
    errors,
    keys,
    photoError,
    value: {
      name,
      email,
      employee_id: employeeId,
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
 * The instructors already holding any of the emails or Employee IDs given,
 * grouped by each. Removed instructors are included: their Employee ID is
 * still reserved by the unique index, so a row using it must be told.
 */
export async function findMatchingInstructors(db, keys) {
  const emails = [...new Set(keys.map((key) => key.email).filter(Boolean))];
  const employeeIds = [...new Set(keys.map((key) => key.employee_id).filter(Boolean))];
  const found = { byEmail: new Map(), byEmployeeId: new Map() };
  const clauses = [];
  if (emails.length) clauses.push({ email: { $in: emails } });
  if (employeeIds.length) clauses.push({ employee_id: { $in: employeeIds } });
  if (!clauses.length) return found;

  const rows = await db.collection("instructors")
    .find({ $or: clauses }, {
      projection: {
        name: 1, email: 1, employee_id: 1, deleted_at: 1, face_ids: 1,
        gender: 1, role: 1, instructor_role: 1, college_id: 1, phone_no: 1,
      },
    })
    .toArray();
  const add = (map, key, row) => map.set(key, [...(map.get(key) || []), row]);
  for (const row of rows) {
    if (row.email) add(found.byEmail, String(row.email).toLowerCase(), row);
    if (row.employee_id) add(found.byEmployeeId, String(row.employee_id), row);
  }
  return found;
}

/**
 * The existing instructor a row updates, if any, or why it cannot.
 *
 * A row matching someone by email or by Employee ID updates that person
 * rather than being refused. What cannot be settled automatically is
 * flagged: the email and the Employee ID belonging to two different people,
 * an email shared by several instructors, and an Employee ID still reserved
 * by someone who was removed.
 */
export function matchExisting(keys, found) {
  const isActive = (row) => !row.deleted_at;
  const byEmail = (found.byEmail.get(keys.email) || []).filter(isActive);
  const byId = found.byEmployeeId.get(keys.employee_id) || [];
  if (byEmail.length > 1) {
    return { error: `Email ${keys.email} is used by ${byEmail.length} instructors; use an email only one of them has` };
  }
  const idOwner = byId.find(isActive) || byId[0];
  if (idOwner?.deleted_at) {
    return { error: `Employee ID ${keys.employee_id} belonged to ${idOwner.name || "an instructor"} who was removed; use a different Employee ID` };
  }
  const emailOwner = byEmail[0];
  if (emailOwner && idOwner && String(emailOwner._id) !== String(idOwner._id)) {
    return {
      error: `Email ${keys.email} belongs to ${emailOwner.name || "one instructor"} but Employee ID ${keys.employee_id} belongs to ${idOwner.name || "another"}; change one of them`,
    };
  }
  const target = emailOwner || idOwner;
  if (!target) return { existing: null };
  return {
    existing: {
      _id: target._id,
      id: String(target._id),
      name: target.name || "",
      hasFace: Array.isArray(target.face_ids) && target.face_ids.some(Boolean),
      record: target,
    },
  };
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
    updateInstructor: deps.updateInstructor,
    enrollPhoto: deps.enrollPhoto || enrollReferencePhoto,
  };
}

async function loadColleges(db) {
  return db.collection("colleges")
    .find(activeFilter(), { projection: { name: 1, location: 1 } })
    .toArray();
}

/** The email and Employee ID a sheet row gives, used to find who it is. */
export function importKeys(raw) {
  return {
    email: firstValue("email", raw?.email).toLowerCase(),
    employee_id: firstValue("employee_id", raw?.employee_id),
  };
}

/** Where each import field lives on an instructor's record. */
const RECORD_VALUES = {
  name: (record) => record.name,
  email: (record) => record.email,
  gender: (record) => record.gender,
  role: (record) => record.instructor_role || record.role,
  institute: (record) => record.college_id,
  employee_id: (record) => record.employee_id,
  phone_no: (record) => record.phone_no,
};

/**
 * A row for an instructor already in the roster, with every blank cell
 * filled from their record. The sheet adds what the record lacks and
 * replaces what it changes; what it leaves blank, or has no column for,
 * stays as it is. `filled` names the fields taken from the record.
 */
export function fillFromRecord(raw, record) {
  const merged = { ...raw };
  const filled = [];
  for (const [field, read] of Object.entries(RECORD_VALUES)) {
    const current = read(record);
    if (!firstValue(field, raw?.[field]) && current != null && text(current)) {
      merged[field] = String(current);
      filled.push(field);
    }
  }
  return { merged, filled };
}

/**
 * Field checks, then the match against the roster and repeats within this
 * batch, then the photograph for whatever is still valid and needs one.
 * Returns one result per row in the order given; `row` is the sheet row
 * number the browser sent.
 *
 * A photograph is needed for a new instructor, and for an existing one who
 * has none enrolled yet. Someone who already has a reference photo keeps it:
 * adding the same sheet's photo again on every re-import would only fill the
 * face collection with copies.
 */
async function checkRows(db, rows, deps) {
  const colleges = await loadColleges(db);
  // Who each row is comes first, from its email or Employee ID, so that an
  // instructor already in the roster can have blank cells filled from their
  // record before the row is judged.
  const found = await findMatchingInstructors(db, rows.map(importKeys));
  const checked = rows.map((raw) => {
    const match = matchExisting(importKeys(raw), found);
    const { merged, filled } = match.existing
      ? fillFromRecord(raw, match.existing.record)
      : { merged: raw, filled: [] };
    const keptRole = match.existing ? text(RECORD_VALUES.role(match.existing.record)) : "";
    return {
      row: raw?.row ?? null,
      match,
      filled,
      ...validateImportFields(merged, colleges, { requirePhoto: false, keptRole }),
    };
  });
  const seenEmails = new Set();
  const seenIds = new Set();

  const results = checked.map((item) => {
    const errors = [...item.errors];
    const { match } = item;
    if (match.error) errors.push(match.error);
    if (item.value) {
      // The browser already removes repeats across the whole file; this only
      // guards a batch sent without that.
      if (seenEmails.has(item.value.email)) errors.push(`Email ${item.value.email} appears more than once`);
      if (seenIds.has(item.value.employee_id)) errors.push(`Employee ID ${item.value.employee_id} appears more than once`);
      seenEmails.add(item.value.email);
      seenIds.add(item.value.employee_id);
    }
    const needsPhoto = !match.existing?.hasFace;
    if (needsPhoto && item.photoError) errors.push(item.photoError);
    return {
      row: item.row,
      errors,
      value: errors.length ? undefined : item.value,
      collegeName: item.collegeName,
      existing: match.existing ?? null,
      filled: item.filled,
      needsPhoto,
    };
  });

  await mapWithConcurrency(results, PHOTO_CONCURRENCY, async (result) => {
    if (!result.value || !result.needsPhoto) return;
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
 * form, saying whether it creates an instructor or updates an existing one
 * and whether its photo will be enrolled, with a thumbnail when it will. A
 * failing row comes back with its reasons.
 */
export async function previewImportRows(db, rows, deps = {}) {
  const resolved = resolveDeps(deps);
  const results = await checkRows(db, rows, resolved);
  return Promise.all(results.map(async (result) => {
    if (!result.value) return { row: result.row, ok: false, errors: result.errors };
    return {
      row: result.row,
      ok: true,
      action: result.existing ? "update" : "create",
      existing: result.existing ? { id: result.existing.id, name: result.existing.name } : null,
      // Fields left blank in the sheet and kept from the instructor's record.
      filled: result.filled,
      photo: result.needsPhoto ? "enrol" : "keep",
      value: { ...result.value, institute: result.collegeName },
      thumbnail: result.photo
        ? await photoThumbnail(result.photo.normalized.buffer).catch(() => null)
        : null,
    };
  }));
}

const UPDATE_REFUSALS = {
  not_found: "The instructor was removed while importing",
  active_attendance: "They are checked in today; check them out before moving them to another institute",
  college_not_found: "The institute was removed while importing",
};

/**
 * Checks a batch again and applies every row that still passes, one at a
 * time: a new instructor is created, an existing one updated with the
 * sheet's values. A blank optional cell such as Phone leaves the value on
 * record as it is.
 *
 * A photograph that is needed is fetched and checked before anything is
 * written, so a bad photo changes nobody. Storing and indexing it happen
 * after, since a face is indexed against the instructor's id; if that step
 * fails the instructor is kept and the row says so, the same as the add form,
 * and the photo can be added from Edit. Rows are written in turn rather than
 * together because each takes a transaction on its institute's record.
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
    const refuse = (message) => outcomes.push({ row: result.row, ok: false, errors: [message] });

    let instructor;
    try {
      if (result.existing) {
        const updated = await resolved.updateInstructor(db, result.existing.id, fields);
        if (updated.outcome === "duplicate_employee_id") {
          refuse(`Employee ID ${fields.employee_id} belongs to another instructor`);
          continue;
        }
        if (updated.outcome !== "updated") {
          refuse(UPDATE_REFUSALS[updated.outcome] || "The instructor could not be updated");
          continue;
        }
        instructor = { _id: result.existing._id, face_ids: [] };
      } else {
        const created = await resolved.createInstructor(db, fields);
        if (created.outcome === "college_not_found") {
          refuse(UPDATE_REFUSALS.college_not_found);
          continue;
        }
        if (created.outcome === "duplicate_employee_id") {
          refuse(`Employee ID ${fields.employee_id} already exists`);
          continue;
        }
        instructor = created.instructor;
      }
    } catch (error) {
      if (error?.code === 11000) {
        refuse("Employee ID already exists");
        continue;
      }
      throw error;
    }

    const verb = result.existing ? "Updated" : "Added";
    const outcome = {
      row: result.row,
      ok: true,
      id: String(instructor._id),
      name: fields.name,
      updated: Boolean(result.existing),
      photo_enrolled: false,
    };
    if (!result.needsPhoto) {
      outcome.photo_kept = true;
    } else if (resolved.faceConfigured) {
      const enrolled = await resolved.enrollPhoto(db, instructor, result.photo.normalized, {
        mode: "add",
        checkedQuality: result.photo.quality,
      });
      if (enrolled.ok) outcome.photo_enrolled = true;
      else outcome.warning = `${verb}, but the photo was not enrolled: ${enrolled.detail}`;
    } else {
      outcome.warning = `${verb}, but the photo was not enrolled: face recognition is not configured`;
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
