// Turns application documents into DynamoDB items and back without losing types.
//
// A document is stored whole, as JSON in the item's `d` attribute. JSON cannot
// carry a Date, a Buffer or a non-finite number, so those are written as small
// tagged objects ({ $date }, { $binary }, { $number }) that no real document
// field can produce, because MongoDB field names may not start with "$".
//
// Ids are strings. New ids keep the 24-character hexadecimal shape of the ids
// copied from the old database (time first, so they sort roughly by creation).
// A BSON ObjectId handed in (from the one-time copy) becomes that hex string.

import { randomBytes } from "node:crypto";

const DATE_TAG = "$date";
const BINARY_TAG = "$binary";
const NUMBER_TAG = "$number";

function isObjectId(value) {
  return value?._bsontype === "ObjectId" && typeof value.toHexString === "function";
}

function isBinary(value) {
  return Buffer.isBuffer(value)
    || value instanceof Uint8Array
    || value?._bsontype === "Binary";
}

function binaryBuffer(value) {
  if (value?._bsontype === "Binary") return Buffer.from(value.buffer);
  return Buffer.from(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Normalises a value coming from application code: ObjectIds become strings,
// undefined becomes null (what the MongoDB driver stores for undefined), and
// Dates, RegExps and Buffers are kept as they are.
export function normalizeValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (isObjectId(value)) return value.toHexString();
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return value;
  if (isBinary(value)) return binaryBuffer(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalizeValue(item);
    return out;
  }
  if (typeof value === "object" && typeof value.toJSON === "function" && !(value instanceof Date)) {
    return normalizeValue(value.toJSON());
  }
  return value;
}

// Filters keep `undefined` as null too, which is how the driver serialises it.
export const normalizeFilter = normalizeValue;

function toJsonValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return { [DATE_TAG]: Number.isNaN(time) ? null : time };
  }
  if (isBinary(value)) return { [BINARY_TAG]: binaryBuffer(value).toString("base64") };
  if (isObjectId(value)) return value.toHexString();
  if (typeof value === "number" && !Number.isFinite(value)) return { [NUMBER_TAG]: String(value) };
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    if (value instanceof RegExp) return { $regex: value.source, $options: value.flags };
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) out[key] = null;
      else out[key] = toJsonValue(item);
    }
    return out;
  }
  return value;
}

function fromJsonValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(fromJsonValue);
  const keys = Object.keys(value);
  if (keys.length === 1) {
    if (keys[0] === DATE_TAG) return value[DATE_TAG] === null ? new Date(Number.NaN) : new Date(value[DATE_TAG]);
    if (keys[0] === BINARY_TAG) return Buffer.from(value[BINARY_TAG], "base64");
    if (keys[0] === NUMBER_TAG) return Number(value[NUMBER_TAG]);
  }
  const out = {};
  for (const key of keys) out[key] = fromJsonValue(value[key]);
  return out;
}

export function encodeDocument(document) {
  return JSON.stringify(toJsonValue(document));
}

export function decodeDocument(text) {
  return fromJsonValue(JSON.parse(text));
}

// Deep copy through the codec, so callers never share objects with the store.
export function cloneDocument(document) {
  return document == null ? document : decodeDocument(encodeDocument(document));
}

export function newDocumentId() {
  const seconds = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  return seconds + randomBytes(8).toString("hex");
}

// ---- Index key encoding ----------------------------------------------------
//
// Index attributes are DynamoDB strings. Each value carries a type prefix so
// that, as in MongoDB, a Date never equals or sorts among strings, and a range
// on dates only ever returns dates.

const NUMBER_OFFSET = 1e15;
export const KEY_PREFIX = Object.freeze({ string: "s:", number: "n:", boolean: "b:", date: "d:" });
export const MISSING_SORT_KEY = "~";

function numberKey(value) {
  if (!Number.isFinite(value) || Math.abs(value) >= NUMBER_OFFSET) return null;
  return (value + NUMBER_OFFSET).toFixed(6).padStart(24, "0");
}

export function keyPart(value) {
  if (typeof value === "string") return `${KEY_PREFIX.string}${value}`;
  if (typeof value === "number") {
    const encoded = numberKey(value);
    return encoded === null ? null : `${KEY_PREFIX.number}${encoded}`;
  }
  if (typeof value === "boolean") return `${KEY_PREFIX.boolean}${value ? 1 : 0}`;
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time) || time < 0 || time > 253402300799999) return null;
    return `${KEY_PREFIX.date}${value.toISOString()}`;
  }
  return null;
}

export function keyPrefixFor(value) {
  if (typeof value === "string") return KEY_PREFIX.string;
  if (typeof value === "number") return KEY_PREFIX.number;
  if (typeof value === "boolean") return KEY_PREFIX.boolean;
  if (value instanceof Date) return KEY_PREFIX.date;
  return null;
}

// Reads a dotted path ("identification.attempted_at") from a document.
export function readPath(document, path) {
  let current = document;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[part];
  }
  return current;
}
