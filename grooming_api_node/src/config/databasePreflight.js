const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EXAMPLES = 20;

export const DATABASE_INDEX_APPLY_CONFIRMATION = "CREATE_INDEXES";

export const REQUIRED_DATABASE_INDEXES = [
  { collection: "users", key: { email: 1 }, options: { unique: true, name: "email_1" } },
  {
    collection: "users",
    key: { email: 1 },
    options: {
      unique: true,
      name: "unique_user_email_casefold",
      collation: { locale: "en", strength: 2 },
    },
  },
  { collection: "boas", key: { employee_id: 1 }, options: { unique: true, name: "employee_id_1" } },
  { collection: "boas", key: { college_id: 1 }, options: { name: "college_id_1" } },
  {
    collection: "instructors",
    key: { employee_id: 1 },
    options: { unique: true, name: "employee_id_1" },
  },
  {
    collection: "instructors",
    key: { college_id: 1, deleted_at: 1, name: 1 },
    options: { name: "college_id_1_deleted_at_1_name_1" },
  },
  {
    collection: "colleges",
    key: { name: 1, location: 1 },
    options: { unique: true, name: "name_1_location_1" },
  },
  {
    collection: "colleges",
    key: { name: 1, location: 1 },
    options: {
      unique: true,
      name: "unique_college_name_location_casefold",
      collation: { locale: "en", strength: 2 },
    },
  },
  {
    collection: "attendance",
    key: { instructor_id: 1, check_in_time: -1 },
    options: { name: "instructor_id_1_check_in_time_-1" },
  },
  {
    collection: "attendance",
    key: { instructor_id: 1 },
    options: {
      unique: true,
      partialFilterExpression: { check_out_time: null },
      name: "one_active_attendance",
    },
  },
  { collection: "attendance", key: { date: -1 }, options: { name: "date_-1" } },
  {
    collection: "attendance",
    key: { college_id: 1, date: -1 },
    options: { name: "college_id_1_date_-1" },
  },
  {
    collection: "attendance",
    key: { "_private_evaluation_outbox.created_at": 1 },
    options: { sparse: true, name: "pending_evaluation_outbox" },
  },
  {
    collection: "attendance",
    key: { "_private_checkin_outbox.created_at": 1 },
    options: { sparse: true, name: "pending_checkin_outbox" },
  },
  {
    collection: "attendance",
    key: { "_private_checkout_outbox.created_at": 1 },
    options: { sparse: true, name: "pending_checkout_outbox" },
  },
  {
    collection: "evaluations",
    key: { attendance_id: 1 },
    options: { unique: true, name: "attendance_id_1" },
  },
  {
    collection: "evaluation_jobs",
    key: { status: 1, available_at: 1, created_at: 1 },
    options: { name: "status_1_available_at_1_created_at_1" },
  },
  {
    collection: "evaluation_jobs",
    key: { status: 1, lease_until: 1 },
    options: { name: "status_1_lease_until_1" },
  },
  {
    collection: "evaluation_jobs",
    key: { status: 1, deadline_at: 1 },
    options: { name: "status_1_deadline_at_1" },
  },
  {
    collection: "evaluation_jobs",
    key: { status: 1, failure_synced_at: 1, failed_at: 1 },
    options: { name: "status_1_failure_synced_at_1_failed_at_1" },
  },
  {
    collection: "evaluation_jobs",
    key: { expires_at: 1 },
    options: { expireAfterSeconds: 0, name: "expires_at_1" },
  },
  {
    collection: "notification_jobs",
    key: { status: 1, available_at: 1, created_at: 1 },
    options: { name: "status_1_available_at_1_created_at_1" },
  },
  {
    collection: "notification_jobs",
    key: { status: 1, lease_until: 1 },
    options: { name: "status_1_lease_until_1" },
  },
  {
    collection: "notification_jobs",
    key: { status: 1, deadline_at: 1 },
    options: { name: "status_1_deadline_at_1" },
  },
  {
    collection: "notification_jobs",
    key: { status: 1, attendance_synced_at: 1 },
    options: { name: "status_1_attendance_synced_at_1" },
  },
  {
    collection: "notification_jobs",
    key: { expires_at: 1 },
    options: { expireAfterSeconds: 0, name: "expires_at_1" },
  },
];

function normalizeText(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    : "";
}

function canonicalIdentifier(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

function isActive(document) {
  return document?.deleted_at == null;
}

function validEmployeeId(value) {
  const canonical = canonicalIdentifier(value);
  return Boolean(canonical) && canonical.length <= 50 && canonical === value;
}

function referenceKey(value) {
  if (typeof value === "string" && value.trim() && value === value.trim()) {
    return `string:${value}`;
  }
  if (value?._bsontype === "ObjectId") return `object-id:${String(value)}`;
  return null;
}

function documentId(document) {
  return String(document?._id ?? "<missing-id>");
}

function examples(values) {
  return {
    items: values.slice(0, MAX_EXAMPLES),
    omitted: Math.max(0, values.length - MAX_EXAMPLES),
  };
}

function groupRows(rows, keyFor) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function sameObject(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function indexOptionsMatch(index, expected) {
  if (Boolean(index.unique) !== Boolean(expected.unique)) return false;
  if (Boolean(index.sparse) !== Boolean(expected.sparse)) return false;
  if (Boolean(index.hidden)) return false;
  if ((index.expireAfterSeconds ?? null) !== (expected.expireAfterSeconds ?? null)) return false;
  if (!sameObject(index.partialFilterExpression ?? null, expected.partialFilterExpression ?? null)) {
    return false;
  }
  if (expected.collation) {
    if (index.collation?.locale !== expected.collation.locale) return false;
    if (index.collation?.strength !== expected.collation.strength) return false;
  } else if (index.collation) {
    return false;
  }
  return true;
}

async function listIndexes(collection) {
  try {
    return await collection.listIndexes().toArray();
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") return [];
    throw error;
  }
}

export async function verifyDatabaseIndexes(db) {
  const collections = [...new Set(REQUIRED_DATABASE_INDEXES.map((index) => index.collection))];
  const indexLists = new Map(await Promise.all(collections.map(async (name) => [
    name,
    await listIndexes(db.collection(name)),
  ])));
  const missing = [];
  const conflicts = [];

  for (const required of REQUIRED_DATABASE_INDEXES) {
    const existing = indexLists.get(required.collection) || [];
    const equivalent = existing.find((index) => (
      sameObject(index.key, required.key) && indexOptionsMatch(index, required.options)
    ));
    if (equivalent) continue;

    const sameName = existing.find((index) => index.name === required.options.name);
    const sameKeyAndCollation = existing.find((index) => (
      sameObject(index.key, required.key)
      && (required.options.collation
        ? index.collation?.locale === required.options.collation.locale
          && index.collation?.strength === required.options.collation.strength
        : !index.collation)
    ));
    const descriptor = {
      collection: required.collection,
      required_index: required.options.name,
    };
    if (sameName || sameKeyAndCollation) {
      conflicts.push({
        ...descriptor,
        existing_index: (sameName || sameKeyAndCollation).name,
      });
    } else {
      missing.push(descriptor);
    }
  }

  return {
    ready: missing.length === 0 && conflicts.length === 0,
    missing,
    conflicts,
  };
}

function finding(code, affectedRecords, exampleItems, remediation) {
  const sample = examples(exampleItems);
  return {
    code,
    severity: "blocking",
    affected_records: affectedRecords,
    examples: sample.items,
    omitted_examples: sample.omitted,
    remediation,
  };
}

function collisionExamples(groups) {
  return groups.map((group) => ({ document_ids: group.map(documentId) }));
}

async function loadPreflightRows(db) {
  return Promise.all([
    db.collection("users").find({}, { projection: { _id: 1, email: 1 } }).toArray(),
    db.collection("boas").find(
      {},
      { projection: { _id: 1, employee_id: 1, college_id: 1, deleted_at: 1 } }
    ).toArray(),
    db.collection("colleges").find(
      {},
      { projection: { _id: 1, name: 1, location: 1, deleted_at: 1 } }
    ).toArray(),
    db.collection("instructors").find(
      {},
      { projection: { _id: 1, email: 1, employee_id: 1, college_id: 1, deleted_at: 1 } }
    ).toArray(),
    db.collection("attendance").find(
      { check_out_time: null },
      { projection: { _id: 1, instructor_id: 1, check_in_time: 1 } }
    ).toArray(),
    db.collection("evaluations").find(
      {},
      { projection: { _id: 1, attendance_id: 1 } }
    ).toArray(),
  ]);
}

export async function auditDatabasePreflight(db, { now = new Date() } = {}) {
  const [[users, boas, colleges, instructors, activeAttendances, evaluations], indexes] = await Promise.all([
    loadPreflightRows(db),
    verifyDatabaseIndexes(db),
  ]);
  const findings = [];

  const invalidUsers = users.filter((user) => {
    const normalized = normalizeText(user.email);
    return !normalized || normalized.length > 254 || !EMAIL_PATTERN.test(normalized);
  });
  if (invalidUsers.length) {
    findings.push(finding(
      "USER_EMAIL_INVALID",
      invalidUsers.length,
      invalidUsers.map((user) => ({ document_id: documentId(user) })),
      "Set a valid, trimmed user email before starting production. Do not disable or merge accounts automatically."
    ));
  }

  const noncanonicalUsers = users.filter((user) => {
    const normalized = normalizeText(user.email);
    return normalized
      && normalized.length <= 254
      && EMAIL_PATTERN.test(normalized)
      && user.email !== normalized;
  });
  if (noncanonicalUsers.length) {
    findings.push(finding(
      "USER_EMAIL_NONCANONICAL",
      noncanonicalUsers.length,
      noncanonicalUsers.map((user) => ({ document_id: documentId(user) })),
      "Rewrite each listed login email to its trimmed, NFKC-normalized lowercase form after resolving any collision. Authentication performs an exact lookup on that canonical value."
    ));
  }

  const userCollisionGroups = [...groupRows(
    users.filter((user) => normalizeText(user.email)),
    (user) => normalizeText(user.email)
  ).values()].filter((group) => group.length > 1);
  if (userCollisionGroups.length) {
    findings.push(finding(
      "USER_EMAIL_COLLISION",
      userCollisionGroups.reduce((total, group) => total + group.length, 0),
      collisionExamples(userCollisionGroups),
      "Choose the authoritative account for each document-id group, reassign references if needed, then rename or disable the others. Login email matching is case-insensitive."
    ));
  }


  const invalidBoas = boas.filter((boa) => !validEmployeeId(boa.employee_id));
  if (invalidBoas.length) {
    findings.push(finding(
      "BOA_EMPLOYEE_ID_INVALID",
      invalidBoas.length,
      invalidBoas.map((boa) => ({ document_id: documentId(boa) })),
      "Set a unique, trimmed employee ID of at most 50 characters on every BOA before creating the unique index."
    ));
  }
  const boaEmployeeCollisionGroups = [...groupRows(
    boas.filter((boa) => validEmployeeId(boa.employee_id)),
    (boa) => boa.employee_id
  ).values()].filter((group) => group.length > 1);
  if (boaEmployeeCollisionGroups.length) {
    findings.push(finding(
      "BOA_EMPLOYEE_ID_COLLISION",
      boaEmployeeCollisionGroups.reduce((total, group) => total + group.length, 0),
      collisionExamples(boaEmployeeCollisionGroups),
      "Choose the authoritative BOA in each document-id group, repair linked user accounts if needed, then assign unique employee IDs."
    ));
  }

  const invalidColleges = colleges.filter((college) => (
    !normalizeText(college.name) || !normalizeText(college.location)
  ));
  if (invalidColleges.length) {
    findings.push(finding(
      "COLLEGE_UNIQUE_KEY_INVALID",
      invalidColleges.length,
      invalidColleges.map((college) => ({ document_id: documentId(college) })),
      "Populate both college name and location before index creation."
    ));
  }
  const collegeCollisionGroups = [...groupRows(
    colleges.filter((college) => normalizeText(college.name) && normalizeText(college.location)),
    (college) => `${normalizeText(college.name)}\u0000${normalizeText(college.location)}`
  ).values()].filter((group) => group.length > 1);
  if (collegeCollisionGroups.length) {
    findings.push(finding(
      "COLLEGE_UNIQUE_KEY_COLLISION",
      collegeCollisionGroups.reduce((total, group) => total + group.length, 0),
      collisionExamples(collegeCollisionGroups),
      "Select one authoritative college in each group and reassign BOA, instructor, and attendance references before removing or renaming duplicates."
    ));
  }


  const activeCollegeIds = new Set(
    colleges.filter(isActive).map((college) => String(college._id))
  );
  const boasWithInvalidCollege = boas.filter((boa) => (
    isActive(boa)
    && (!referenceKey(boa.college_id) || !activeCollegeIds.has(String(boa.college_id)))
  ));
  if (boasWithInvalidCollege.length) {
    findings.push(finding(
      "ACTIVE_BOA_COLLEGE_INVALID",
      boasWithInvalidCollege.length,
      boasWithInvalidCollege.map((boa) => ({ document_id: documentId(boa) })),
      "Assign each active BOA to an existing active college, or disable the BOA if the account is no longer used."
    ));
  }

  const invalidInstructorEmployeeIds = instructors.filter(
    (instructor) => !validEmployeeId(instructor.employee_id)
  );
  if (invalidInstructorEmployeeIds.length) {
    findings.push(finding(
      "INSTRUCTOR_EMPLOYEE_ID_INVALID",
      invalidInstructorEmployeeIds.length,
      invalidInstructorEmployeeIds.map((instructor) => ({ document_id: documentId(instructor) })),
      "Set a unique, trimmed employee ID of at most 50 characters on every instructor, including archived instructors, before creating the unique index."
    ));
  }
  const instructorEmployeeCollisionGroups = [...groupRows(
    instructors.filter((instructor) => validEmployeeId(instructor.employee_id)),
    (instructor) => instructor.employee_id
  ).values()].filter((group) => group.length > 1);
  if (instructorEmployeeCollisionGroups.length) {
    findings.push(finding(
      "INSTRUCTOR_EMPLOYEE_ID_COLLISION",
      instructorEmployeeCollisionGroups.reduce((total, group) => total + group.length, 0),
      collisionExamples(instructorEmployeeCollisionGroups),
      "Preserve the authoritative instructor record in each document-id group and assign unique employee IDs to the others; do not delete attendance history."
    ));
  }

  const activeInstructors = instructors.filter(isActive);
  const invalidInstructors = activeInstructors.filter((instructor) => {
    const email = instructor.email;
    return typeof email !== "string"
      || !email
      || email.length > 254
      || !EMAIL_PATTERN.test(email);
  });
  if (invalidInstructors.length) {
    findings.push(finding(
      "INSTRUCTOR_EMAIL_INVALID",
      invalidInstructors.length,
      invalidInstructors.map((instructor) => ({ document_id: documentId(instructor) })),
      "Set a valid email for every active instructor so check-in and checkout reports have a recipient."
    ));
  }

  const instructorsWithInvalidCollege = activeInstructors.filter((instructor) => (
    !referenceKey(instructor.college_id)
    || !activeCollegeIds.has(String(instructor.college_id))
  ));
  if (instructorsWithInvalidCollege.length) {
    findings.push(finding(
      "ACTIVE_INSTRUCTOR_COLLEGE_INVALID",
      instructorsWithInvalidCollege.length,
      instructorsWithInvalidCollege.map((instructor) => ({ document_id: documentId(instructor) })),
      "Assign each active instructor to an existing active college, or archive the instructor after resolving active attendance."
    ));
  }

  const attendanceWithoutInstructor = activeAttendances.filter((row) => (
    referenceKey(row.instructor_id) == null
  ));
  if (attendanceWithoutInstructor.length) {
    findings.push(finding(
      "ACTIVE_ATTENDANCE_INSTRUCTOR_INVALID",
      attendanceWithoutInstructor.length,
      attendanceWithoutInstructor.map((row) => ({ attendance_id: documentId(row) })),
      "Repair the instructor reference or close the invalid attendance record after confirming its owner."
    ));
  }

  const activeInstructorIds = new Set(
    activeInstructors.map((instructor) => String(instructor._id))
  );
  const attendanceWithInactiveInstructor = activeAttendances.filter((row) => (
    referenceKey(row.instructor_id) != null
    && !activeInstructorIds.has(String(row.instructor_id))
  ));
  if (attendanceWithInactiveInstructor.length) {
    findings.push(finding(
      "ACTIVE_ATTENDANCE_INSTRUCTOR_NOT_ACTIVE",
      attendanceWithInactiveInstructor.length,
      attendanceWithInactiveInstructor.map((row) => ({
        attendance_id: documentId(row),
        instructor_id: String(row.instructor_id),
      })),
      "After confirming ownership, reassign the attendance to an existing active instructor or record an accurate check_out_time. Preserve attendance history instead of deleting it."
    ));
  }
  const activeCollisionGroups = [...groupRows(
    activeAttendances.filter((row) => referenceKey(row.instructor_id) != null),
    (row) => String(row.instructor_id)
  ).values()].filter((group) => group.length > 1);
  if (activeCollisionGroups.length) {
    findings.push(finding(
      "ACTIVE_ATTENDANCE_COLLISION",
      activeCollisionGroups.reduce((total, group) => total + group.length, 0),
      activeCollisionGroups.map((group) => ({
        instructor_id: String(group[0].instructor_id),
        attendance_ids: group.map(documentId),
      })),
      "Choose the authoritative active attendance and set an accurate check_out_time on the others. Preserve history; do not delete records blindly."
    ));
  }


  const invalidEvaluations = evaluations.filter((evaluation) => (
    referenceKey(evaluation.attendance_id) == null
  ));
  if (invalidEvaluations.length) {
    findings.push(finding(
      "EVALUATION_ATTENDANCE_ID_INVALID",
      invalidEvaluations.length,
      invalidEvaluations.map((evaluation) => ({ document_id: documentId(evaluation) })),
      "Repair each evaluation's attendance reference after confirming the source attendance record."
    ));
  }
  const evaluationCollisionGroups = [...groupRows(
    evaluations.filter((evaluation) => referenceKey(evaluation.attendance_id) != null),
    (evaluation) => referenceKey(evaluation.attendance_id)
  ).values()].filter((group) => group.length > 1);
  if (evaluationCollisionGroups.length) {
    findings.push(finding(
      "EVALUATION_ATTENDANCE_ID_COLLISION",
      evaluationCollisionGroups.reduce((total, group) => total + group.length, 0),
      collisionExamples(evaluationCollisionGroups),
      "Choose the authoritative evaluation for each attendance, preserve any needed audit data, and remove or relink duplicates before index creation."
    ));
  }

  const blockingRecords = findings.reduce((total, item) => total + item.affected_records, 0);
  const blocked = findings.length > 0 || indexes.conflicts.length > 0;
  return {
    generated_at: now.toISOString(),
    status: blocked ? "blocked" : (indexes.ready ? "ready" : "safe_to_apply_indexes"),
    safe_to_apply_indexes: !blocked,
    summary: {
      blocking_checks: findings.length,
      affected_records: blockingRecords,
      missing_indexes: indexes.missing.length,
      conflicting_indexes: indexes.conflicts.length,
    },
    findings,
    indexes,
  };
}

export class DatabasePreflightError extends Error {
  constructor(report, message = "Database preflight blocked startup") {
    const codes = report.findings.map((item) => item.code).join(", ");
    const suffix = codes ? `: ${codes}` : "";
    super(`${message}${suffix}. Run npm run db:preflight for the actionable report.`);
    this.name = "DatabasePreflightError";
    this.report = report;
  }
}

export function assertDatabasePreflightSafe(report) {
  if (report.findings.length || report.indexes.conflicts.length) {
    throw new DatabasePreflightError(report);
  }
  return report;
}

export async function applyDatabaseIndexes(db, { confirmation } = {}) {
  if (confirmation !== DATABASE_INDEX_APPLY_CONFIRMATION) {
    throw new Error(
      `Index apply requires DATABASE_PREFLIGHT_APPLY=${DATABASE_INDEX_APPLY_CONFIRMATION}`
    );
  }
  const report = await auditDatabasePreflight(db);
  assertDatabasePreflightSafe(report);

  const missingNames = new Set(report.indexes.missing.map((item) => (
    `${item.collection}:${item.required_index}`
  )));
  const applied = [];
  for (const required of REQUIRED_DATABASE_INDEXES) {
    if (!missingNames.has(`${required.collection}:${required.options.name}`)) continue;
    const name = await db.collection(required.collection).createIndex(
      required.key,
      required.options
    );
    applied.push({ collection: required.collection, index: name });
  }

  const indexes = await verifyDatabaseIndexes(db);
  if (!indexes.ready) {
    throw new Error("Index creation finished without satisfying the required index contract");
  }
  return { report, applied, indexes };
}

export function formatDatabasePreflightReport(report) {
  const lines = [
    `Database preflight: ${report.status}`,
    `Blocking checks: ${report.summary.blocking_checks}; affected records: ${report.summary.affected_records}`,
    `Missing indexes: ${report.summary.missing_indexes}; conflicting indexes: ${report.summary.conflicting_indexes}`,
  ];
  for (const item of report.findings) {
    lines.push(`- ${item.code}: ${item.affected_records} affected record(s). ${item.remediation}`);
    for (const example of item.examples) lines.push(`  ${JSON.stringify(example)}`);
    if (item.omitted_examples) lines.push(`  ... ${item.omitted_examples} additional example(s) omitted`);
  }
  for (const conflict of report.indexes.conflicts) {
    lines.push(
      `- INDEX_CONFLICT: ${conflict.collection}.${conflict.existing_index} does not satisfy ${conflict.required_index}; inspect and replace it manually during a maintenance window.`
    );
  }
  if (report.indexes.missing.length) {
    lines.push("Missing indexes can be created only after all blockers are resolved, using the explicitly confirmed apply command.");
  }
  return lines.join("\n");
}
