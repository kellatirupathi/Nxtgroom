// Database errors. Handlers recognise them by code: 11000 for a duplicate
// value under a unique rule, 112 for a write conflict, 66 for an attempt to
// change a document id.

export class DuplicateKeyError extends Error {
  constructor(collection, indexName, fields, values) {
    const keyValue = Object.fromEntries(fields.map((field, index) => [field, values[index] ?? null]));
    super(
      `E11000 duplicate key error collection: ${collection} index: ${indexName} dup key: ${JSON.stringify(keyValue)}`
    );
    this.name = "DuplicateKeyError";
    this.code = 11000;
    this.codeName = "DuplicateKey";
    this.keyPattern = Object.fromEntries(fields.map((field) => [field, 1]));
    this.keyValue = keyValue;
    this.index = indexName;
  }
}

// Another writer changed the document between our read and our write.
// Single writes retry on their own; a transaction retries as a whole.
export class WriteConflictError extends Error {
  constructor(message = "Write conflict; the operation will be retried") {
    super(message);
    this.name = "WriteConflictError";
    this.code = 112;
    this.codeName = "WriteConflict";
    this.errorLabels = ["TransientTransactionError"];
  }

  hasErrorLabel(label) {
    return this.errorLabels.includes(label);
  }
}

export class ImmutableFieldError extends Error {
  constructor() {
    super("Performing an update on the path '_id' would modify the immutable field '_id'");
    this.name = "ImmutableFieldError";
    this.code = 66;
    this.codeName = "ImmutableField";
  }
}
