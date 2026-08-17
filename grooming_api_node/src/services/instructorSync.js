import { BigQuery } from "@google-cloud/bigquery";

/**
 * Pulls the instructor roster from BigQuery into MongoDB.
 *
 * The BigQuery table is the system of record for who exists; FacultyTrack owns
 * the attendance and grooming data keyed to those people. Syncing a local copy
 * means every screen reads from Mongo at Mongo speed, and the roster stays
 * usable if BigQuery is unreachable.
 */

const DATASET = "niat_instructor_automation_data";
const TABLE = "niat_instructor_managers_and_instructors_details";
export const SYNC_STATE_ID = "instructor_sync";

/** Guards against a runaway query; the roster is a few thousand rows. */
const MAX_ROWS = 50_000;

let client = null;
let clientFingerprint = "";

function credentials() {
  const raw = process.env.BIGQUERY_CREDENTIALS_JSON;
  if (!raw) return null;
  try {
    // Accept either the raw JSON or a base64 copy, because some hosts mangle
    // multi-line values in their environment editor.
    const decoded = raw.trim().startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    console.error("BIGQUERY_CREDENTIALS_JSON is not valid JSON or base64 JSON");
    return null;
  }
}

export function isSyncConfigured() {
  return Boolean(credentials());
}

function getClient() {
  const creds = credentials();
  if (!creds) throw new Error("BigQuery credentials are not configured");
  const fingerprint = `${creds.project_id}|${creds.client_email}`;
  if (!client || clientFingerprint !== fingerprint) {
    client = new BigQuery({
      projectId: process.env.BIGQUERY_PROJECT_ID || creds.project_id,
      credentials: {
        client_email: creds.client_email,
        private_key: creds.private_key,
      },
    });
    clientFingerprint = fingerprint;
  }
  return client;
}

/** Trims and collapses whitespace; returns null for anything empty. */
function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/\s+/g, " ");
  return text.length ? text : null;
}

/**
 * Maps one BigQuery row onto the fields FacultyTrack stores. Column names are
 * matched case-insensitively because the warehouse is not consistent about
 * casing between tables.
 */
export function mapInstructorRow(row) {
  const lookup = new Map(
    Object.entries(row || {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  const pick = (...names) => {
    for (const name of names) {
      const value = clean(lookup.get(name));
      if (value) return value;
    }
    return null;
  };

  const userId = pick("instructor_user_id", "instructoruserid", "user_id");
  const name = pick("instructor_name", "instructorname");
  if (!userId || !name) return null;

  return {
    instructor_user_id: userId,
    name,
    instructor_role: pick("instructor_role", "instructorrole"),
    institute_name: pick("institute_name", "institutename"),
    instructor_category: pick("instructor_category", "instructorcategory"),
    // Present on some rows only; both are optional in FacultyTrack.
    employee_id: pick("employee_id", "employeeid"),
    phone_no: pick("employee_mobile_number", "instructor_mobile_number", "mobile_number", "phone_no"),
    email: (pick("instructor_email", "instructor_mail", "email") || "").toLowerCase() || null,
    manager_email: (pick("instructor_manager_mail", "manager_email") || "").toLowerCase() || null,
  };
}

/** Fetches and normalises the roster. Rows missing an id or name are skipped. */
export async function fetchInstructorRoster() {
  const projectId = process.env.BIGQUERY_PROJECT_ID || credentials()?.project_id;
  const query = `
    SELECT *
    FROM \`${projectId}.${DATASET}.${TABLE}\`
    LIMIT ${MAX_ROWS}
  `;
  const [rows] = await getClient().query({ query, location: process.env.BIGQUERY_LOCATION || undefined });

  const mapped = [];
  const seen = new Set();
  let skipped = 0;
  for (const row of rows) {
    const record = mapInstructorRow(row);
    if (!record) {
      skipped += 1;
      continue;
    }
    // The warehouse can repeat a person across manager rows; keep one.
    if (seen.has(record.instructor_user_id)) continue;
    seen.add(record.instructor_user_id);
    mapped.push(record);
  }
  return { records: mapped, fetched: rows.length, skipped };
}

/**
 * Writes the roster into the `instructors` collection, keyed on
 * instructor_user_id, so synced people appear on the Instructors page and can
 * be selected for attendance like any other record.
 *
 * The sync is strictly additive. It adds instructors that are new, updates
 * values that changed, and touches nothing else — there is no delete, drop or
 * replace anywhere in this path, and every write is addressed to an id present
 * in the current roster.
 *
 * That matters because an instructor who has left the BigQuery roster still
 * has attendance and grooming history here, and removing the row would orphan
 * it. Someone who disappears from the warehouse simply keeps their record with
 * an older synced_at. instructor-sync-additive.test.js asserts this by
 * inspecting the generated operations, so a destructive change fails there
 * before it could ever reach a database.
 *
 * Fields FacultyTrack owns — college assignment, gender, soft deletion — live
 * in $setOnInsert so a re-sync cannot reset them.
 */
export async function saveInstructorRoster(db, records) {
  if (!records.length) return { upserted: 0, modified: 0 };
  const now = new Date();
  const operations = records.map((record) => {
    // Only overwrite the columns BigQuery is authoritative for. Writing null
    // over a locally set email or phone would undo an administrator's edit.
    const owned = { ...record };
    for (const key of ["employee_id", "phone_no", "email", "manager_email"]) {
      if (owned[key] === null) delete owned[key];
    }
    return {
      updateOne: {
        filter: { instructor_user_id: record.instructor_user_id },
        update: {
          $set: { ...owned, source: "bigquery", synced_at: now, updated_at: now },
          $setOnInsert: { created_at: now, deleted_at: null, college_id: null, gender: null },
        },
        upsert: true,
      },
    };
  });

  let upserted = 0;
  let modified = 0;
  // Batched so one oversized bulk write cannot exceed the 16MB command limit.
  const BATCH = 500;
  for (let index = 0; index < operations.length; index += BATCH) {
    const result = await db.collection("instructors").bulkWrite(
      operations.slice(index, index + BATCH),
      { ordered: false }
    );
    upserted += result.upsertedCount || 0;
    modified += result.modifiedCount || 0;
  }
  return { upserted, modified };
}

export async function readSyncState(db) {
  return db.collection("app_settings").findOne({ _id: SYNC_STATE_ID });
}

export async function writeSyncState(db, state) {
  await db.collection("app_settings").updateOne(
    { _id: SYNC_STATE_ID },
    { $set: { ...state, _id: SYNC_STATE_ID } },
    { upsert: true }
  );
}

/** Runs one sync end to end and records the outcome for the Settings screen. */
export async function runInstructorSync(db, { triggeredBy } = {}) {
  const startedAt = new Date();
  try {
    const { records, fetched, skipped } = await fetchInstructorRoster();
    const { upserted, modified } = await saveInstructorRoster(db, records);
    const state = {
      last_sync_at: new Date(),
      last_sync_status: "success",
      last_sync_error: null,
      last_sync_by: triggeredBy || null,
      record_count: records.length,
      rows_fetched: fetched,
      rows_skipped: skipped,
      upserted,
      modified,
      duration_ms: Date.now() - startedAt.getTime(),
    };
    await writeSyncState(db, state);
    return { ok: true, ...state };
  } catch (error) {
    const state = {
      last_sync_at: new Date(),
      last_sync_status: "failed",
      // Message only: a stack trace here would surface in the admin UI.
      last_sync_error: error?.message?.slice(0, 300) || "Sync failed",
      last_sync_by: triggeredBy || null,
      duration_ms: Date.now() - startedAt.getTime(),
    };
    await writeSyncState(db, state);
    return { ok: false, ...state };
  }
}
