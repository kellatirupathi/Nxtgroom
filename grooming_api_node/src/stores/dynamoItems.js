/**
 * Translation between the documents the application works with and DynamoDB
 * items.
 *
 * DynamoDB has no date type, so a Date is stored as its ISO-8601 UTC string,
 * which also sorts correctly when a date is part of a key. Reading converts
 * exactly that format back, so the application keeps receiving Date objects.
 * A string field that happens to hold a full millisecond ISO timestamp would
 * come back as a Date too; no field in this application does.
 */

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function toItem(value) {
  if (value instanceof Date) return value.toISOString();
  // A legacy MongoDB ObjectId: keys are plain strings in DynamoDB.
  if (value?._bsontype === "ObjectId") return value.toHexString();
  if (Array.isArray(value)) return value.map(toItem);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const item = {};
    for (const [key, field] of Object.entries(value)) {
      if (field !== undefined) item[key] = toItem(field);
    }
    return item;
  }
  return value;
}

export function fromItem(value) {
  if (typeof value === "string") return ISO_TIMESTAMP.test(value) ? new Date(value) : value;
  if (Array.isArray(value)) return value.map(fromItem);
  if (value instanceof Set) return [...value].map(fromItem);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const document = {};
    for (const [key, field] of Object.entries(value)) document[key] = fromItem(field);
    return document;
  }
  return value;
}

/**
 * An UpdateExpression equivalent to MongoDB's { $set, $setOnInsert } with
 * upsert: $set fields always overwrite, $setOnInsert fields are written only
 * when absent. Key attributes are skipped; the Key names the item.
 *
 * name() and value() register further placeholders, so a caller can add its
 * own clauses and conditions to the same command.
 */
export function upsertExpression({ set = {}, setOnInsert = {} } = {}, { keyNames = ["_id"] } = {}) {
  const names = {};
  const values = {};
  const clauses = [];
  let nameCount = 0;
  let valueCount = 0;
  const name = (field) => {
    const placeholder = `#f${nameCount++}`;
    names[placeholder] = field;
    return placeholder;
  };
  const value = (fieldValue) => {
    const placeholder = `:v${valueCount++}`;
    values[placeholder] = toItem(fieldValue);
    return placeholder;
  };
  for (const [field, fieldValue] of Object.entries(set)) {
    if (keyNames.includes(field) || fieldValue === undefined) continue;
    clauses.push(`${name(field)} = ${value(fieldValue)}`);
  }
  for (const [field, fieldValue] of Object.entries(setOnInsert)) {
    if (keyNames.includes(field) || fieldValue === undefined || field in set) continue;
    const fieldName = name(field);
    clauses.push(`${fieldName} = if_not_exists(${fieldName}, ${value(fieldValue)})`);
  }
  return { clauses, names, values, name, value };
}

export function isConditionFailure(error) {
  return error?.name === "ConditionalCheckFailedException";
}

/**
 * UpdateCommand input for MongoDB updateOne(key, { $set, $setOnInsert },
 * { upsert: true }), or null when there is nothing to write.
 */
export function upsertCommandInput(tableName, key, { set = {}, setOnInsert } = {}) {
  const expression = upsertExpression({ set, setOnInsert }, { keyNames: Object.keys(key) });
  if (!expression.clauses.length) return null;
  return {
    TableName: tableName,
    Key: key,
    UpdateExpression: `SET ${expression.clauses.join(", ")}`,
    ExpressionAttributeNames: expression.names,
    ExpressionAttributeValues: expression.values,
  };
}
