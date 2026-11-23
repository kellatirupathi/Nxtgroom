// The DynamoDB layout of every collection the application uses.
//
// Each collection is one table, keyed by `_id`. Lookups other than by `_id` go
// through global secondary indexes (GSIs) declared here; anything else falls
// back to a table scan, which is correct but costs a read of the whole table.
//
// Index kinds:
//   { pk: "field" }                    equality on one field
//   { pk: "field", sk: "field" }       equality plus an optional range or sort
//   { pk: null, sk: "field" }          a range over one field across the table
//   { pk: null, sk: "a.b", sparseOn }  as above, holding only items where the
//                                      `sparseOn` field exists (queue outboxes)
//
// Unique constraints (one attendance per instructor per day, one account per
// email, ...). DynamoDB only enforces uniqueness on a table's
// primary key, so each constraint is kept as a guard item in the shared
// `_unique` table, written in the same transaction as the document.
//
// Index fields must hold single values (never arrays) for an index to answer
// every matching document.

export const SCHEMA_VERSION = 1;

const OUTBOX_INDEXES = [
  "_private_evaluation_outbox",
  "_private_checkin_outbox",
  "_private_checkout_outbox",
].map((field) => ({
  name: field.replace(/^_private_/, ""),
  pk: null,
  sk: `${field}.created_at`,
  sparseOn: field,
}));

const JOB_INDEXES = [{ name: "by_status", pk: "status", sk: "available_at" }];

export const COLLECTIONS = Object.freeze({
  users: {
    indexes: [{ name: "by_email", pk: "email" }],
    unique: [{ name: "unique_user_email_casefold", fields: ["email"], casefold: true }],
  },
  password_resets: {
    indexes: [
      { name: "by_email", pk: "email" },
      { name: "by_token_hash", pk: "token_hash" },
    ],
    unique: [
      { name: "email_1", fields: ["email"] },
      { name: "token_hash_1", fields: ["token_hash"] },
    ],
    ttlField: "expires_at",
  },
  boas: {
    indexes: [
      { name: "by_college", pk: "college_id" },
      { name: "by_employee_id", pk: "employee_id" },
    ],
    unique: [{ name: "employee_id_1", fields: ["employee_id"] }],
  },
  colleges: {
    indexes: [{ name: "by_name", pk: "name" }],
    unique: [{ name: "unique_college_name_location_casefold", fields: ["name", "location"], casefold: true }],
  },
  instructors: {
    indexes: [
      { name: "by_college", pk: "college_id", sk: "name" },
      { name: "by_user_id", pk: "instructor_user_id" },
      { name: "by_employee_id", pk: "employee_id" },
      { name: "by_report_token", pk: "report_token" },
      { name: "by_email", pk: "email" },
    ],
    unique: [
      { name: "employee_id_string_unique", fields: ["employee_id"], requireStrings: true },
      { name: "report_token_unique", fields: ["report_token"], requireStrings: true },
      { name: "instructor_user_id_unique", fields: ["instructor_user_id"], requireStrings: true },
    ],
  },
  attendance: {
    indexes: [
      { name: "by_instructor", pk: "instructor_id", sk: "check_in_time" },
      { name: "by_college_date", pk: "college_id", sk: "date" },
      { name: "by_date", pk: null, sk: "date" },
      { name: "by_day", pk: "attendance_day" },
      ...OUTBOX_INDEXES,
    ],
    unique: [
      { name: "one_attendance_per_day", fields: ["instructor_id", "attendance_day"], requireStrings: true },
    ],
  },
  evaluations: {
    indexes: [
      { name: "by_attendance", pk: "attendance_id", sk: "kind" },
      { name: "by_processed_at", pk: null, sk: "processed_at" },
    ],
    unique: [{ name: "attendance_id_1_kind_1", fields: ["attendance_id", "kind"] }],
  },
  evaluation_jobs: { indexes: JOB_INDEXES, unique: [], ttlField: "expires_at" },
  notification_jobs: { indexes: JOB_INDEXES, unique: [], ttlField: "expires_at" },
  mail_jobs: { indexes: JOB_INDEXES, unique: [], ttlField: "expires_at" },
  storage_cleanup_jobs: { indexes: JOB_INDEXES, unique: [] },
  audit_logs: { indexes: [{ name: "by_time", pk: null, sk: "at" }], unique: [] },
  app_settings: { indexes: [], unique: [] },
  report_delivery_runs: { indexes: [], unique: [] },
  // One public grooming-photo form link per institute (see services/instituteForms.js).
  institute_form_links: {
    indexes: [
      { name: "by_token", pk: "token" },
      { name: "by_college", pk: "college_id" },
    ],
    unique: [
      { name: "form_link_token_unique", fields: ["token"], requireStrings: true },
      { name: "form_link_college_unique", fields: ["college_id"], requireStrings: true },
    ],
  },
  // One answer per institute per day to the grooming-photo form, filled in
  // through the public link ("automatic") or imported by an admin ("manual").
  form_responses: {
    indexes: [
      { name: "by_college_date", pk: "college_id", sk: "form_date" },
      { name: "by_date", pk: null, sk: "form_date" },
    ],
    unique: [
      { name: "one_form_response_per_day", fields: ["college_id", "form_date"], requireStrings: true },
    ],
  },
});

export const COLLECTION_NAMES = Object.freeze(Object.keys(COLLECTIONS));

export const ID_ATTRIBUTE = "_id";
export const DOCUMENT_ATTRIBUTE = "d";
export const VERSION_ATTRIBUTE = "v";
export const TTL_ATTRIBUTE = "ttl";
export const UNIQUE_KEY_ATTRIBUTE = "k";
export const UNIQUE_OWNER_ATTRIBUTE = "owner";
export const UNIQUE_TABLE_SUFFIX = "_unique";
export const CONSTANT_PARTITION = "all";

export function collectionSchema(name) {
  const schema = COLLECTIONS[name];
  if (!schema) {
    const error = new Error(
      `Collection "${name}" has no DynamoDB table. Add it to src/docdb/schema.js and run npm run dynamodb:tables:apply.`
    );
    error.code = "UNKNOWN_COLLECTION";
    throw error;
  }
  return schema;
}

export function indexAttributes(index) {
  return {
    pk: `${index.name}_pk`,
    sk: index.sk ? `${index.name}_sk` : null,
  };
}

export function tableNameFor(prefix, collection) {
  return `${prefix}db-${collection}`;
}

export function uniqueTableName(prefix) {
  return `${prefix}db-${UNIQUE_TABLE_SUFFIX}`;
}

// CreateTable input for one collection.
export function tableDefinition(prefix, collection) {
  const schema = collectionSchema(collection);
  const attributes = new Map([[ID_ATTRIBUTE, "S"]]);
  const indexes = schema.indexes.map((index) => {
    const names = indexAttributes(index);
    attributes.set(names.pk, "S");
    if (names.sk) attributes.set(names.sk, "S");
    return {
      IndexName: index.name,
      KeySchema: [
        { AttributeName: names.pk, KeyType: "HASH" },
        ...(names.sk ? [{ AttributeName: names.sk, KeyType: "RANGE" }] : []),
      ],
      Projection: { ProjectionType: "ALL" },
    };
  });
  return {
    TableName: tableNameFor(prefix, collection),
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [...attributes].map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType })),
    KeySchema: [{ AttributeName: ID_ATTRIBUTE, KeyType: "HASH" }],
    ...(indexes.length ? { GlobalSecondaryIndexes: indexes } : {}),
  };
}

export function uniqueTableDefinition(prefix) {
  return {
    TableName: uniqueTableName(prefix),
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: UNIQUE_KEY_ATTRIBUTE, AttributeType: "S" }],
    KeySchema: [{ AttributeName: UNIQUE_KEY_ATTRIBUTE, KeyType: "HASH" }],
  };
}

// Every table the store needs, with whether it uses DynamoDB TTL.
export function allTableDefinitions(prefix) {
  return [
    ...COLLECTION_NAMES.map((name) => ({
      collection: name,
      definition: tableDefinition(prefix, name),
      ttl: Boolean(COLLECTIONS[name].ttlField),
    })),
    { collection: UNIQUE_TABLE_SUFFIX, definition: uniqueTableDefinition(prefix), ttl: true },
  ];
}
