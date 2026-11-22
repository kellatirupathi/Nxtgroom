// Chooses how to fetch the documents that might match a MongoDB-style filter.
//
// The plan only narrows the candidates; the full filter is always applied to
// them afterwards, so a plan may return extra documents but must never miss
// one that matches. That is why only simple, single-valued conditions are
// pushed down to DynamoDB.

import { CONSTANT_PARTITION } from "./schema.js";
import { keyPart, keyPrefixFor } from "./codec.js";

const MAX_KEY_VALUES = 50;

function isScalar(value) {
  return typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value))
    || typeof value === "boolean"
    || (value instanceof Date && !Number.isNaN(value.getTime()));
}

function isOperatorObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date || value instanceof RegExp) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith("$"));
}

// Every [field, condition] pair that must hold, from the top level and from
// nested $and clauses. $or, $nor and $expr add nothing here.
export function conjuncts(filter, out = []) {
  if (!filter || typeof filter !== "object") return out;
  for (const [key, condition] of Object.entries(filter)) {
    if (key === "$and" && Array.isArray(condition)) {
      for (const clause of condition) conjuncts(clause, out);
    } else if (!key.startsWith("$")) {
      out.push([key, condition]);
    }
  }
  return out;
}

// The finite set of single values a condition requires, or null.
export function equalityValues(condition) {
  if (isScalar(condition)) return [condition];
  if (!isOperatorObject(condition)) return null;
  if ("$eq" in condition) return isScalar(condition.$eq) ? [condition.$eq] : null;
  if (Array.isArray(condition.$in)) {
    if (!condition.$in.length || condition.$in.length > MAX_KEY_VALUES) return null;
    if (!condition.$in.every(isScalar)) return null;
    const seen = new Map();
    for (const value of condition.$in) seen.set(keyPart(value), value);
    return [...seen.values()];
  }
  return null;
}

// An inclusive [from, to] range of encoded keys covering a range condition.
export function rangeOf(condition) {
  if (!isOperatorObject(condition)) return null;
  const lower = condition.$gte ?? condition.$gt;
  const upper = condition.$lte ?? condition.$lt;
  if (lower === undefined && upper === undefined) return null;
  if (lower !== undefined && !isScalar(lower)) return null;
  if (upper !== undefined && !isScalar(upper)) return null;
  const prefix = keyPrefixFor(lower ?? upper);
  if (lower !== undefined && upper !== undefined && keyPrefixFor(lower) !== keyPrefixFor(upper)) return null;
  const from = lower === undefined ? prefix : keyPart(lower);
  const to = upper === undefined ? `${prefix}￿` : keyPart(upper);
  if (from === null || to === null) return null;
  return { from, to };
}

function impliesExistence(condition) {
  if (!isOperatorObject(condition)) return condition !== null && condition !== undefined;
  if (condition.$exists === true) return true;
  if ("$ne" in condition && condition.$ne === null) return true;
  return ["$gt", "$gte", "$lt", "$lte", "$eq", "$in"].some((op) => op in condition && condition[op] !== null);
}

function conditionsFor(pairs, field) {
  return pairs.filter(([key]) => key === field).map(([, condition]) => condition);
}

function firstEquality(pairs, field) {
  for (const condition of conditionsFor(pairs, field)) {
    const values = equalityValues(condition);
    if (values) return values;
  }
  return null;
}

function sortKeyCondition(pairs, field) {
  for (const condition of conditionsFor(pairs, field)) {
    const values = equalityValues(condition);
    if (values?.length === 1) {
      const encoded = keyPart(values[0]);
      if (encoded !== null) return { skEquals: encoded };
    }
  }
  for (const condition of conditionsFor(pairs, field)) {
    const range = rangeOf(condition);
    if (range) return { skFrom: range.from, skTo: range.to };
  }
  return null;
}

function uniqueValue(value, constraint) {
  if (constraint.requireStrings && typeof value !== "string") return null;
  return value;
}

export function planQuery(schema, filter) {
  const pairs = conjuncts(filter || {});

  const ids = firstEquality(pairs, "_id");
  if (ids) {
    if (ids.every((id) => typeof id === "string")) return { kind: "ids", ids };
    return { kind: "empty" };
  }

  for (const constraint of schema.unique) {
    const values = constraint.fields.map((field) => {
      const found = firstEquality(pairs, field);
      return found?.length === 1 ? uniqueValue(found[0], constraint) : null;
    });
    if (values.every((value) => value !== null && value !== undefined)) {
      return { kind: "unique", constraint, values };
    }
  }

  let best = null;
  const consider = (plan, score) => {
    if (!best || score > best.score) best = { ...plan, score };
  };
  for (const index of schema.indexes) {
    if (index.pk) {
      const values = firstEquality(pairs, index.pk);
      if (!values) continue;
      const encoded = values.map(keyPart);
      if (encoded.some((value) => value === null)) continue;
      const sk = index.sk ? sortKeyCondition(pairs, index.sk) : null;
      consider({ kind: "index", index, pkValues: encoded, ...(sk || {}) }, 4 + (sk ? 2 : 0) - (encoded.length > 1 ? 1 : 0));
    } else if (index.sparseOn) {
      const required = conditionsFor(pairs, index.sparseOn).some(impliesExistence)
        || conditionsFor(pairs, index.sk).some(impliesExistence);
      if (!required) continue;
      const sk = sortKeyCondition(pairs, index.sk);
      consider({ kind: "index", index, pkValues: [CONSTANT_PARTITION], ...(sk || {}) }, 3);
    } else if (index.sk) {
      const sk = sortKeyCondition(pairs, index.sk);
      if (!sk) continue;
      consider({ kind: "index", index, pkValues: [CONSTANT_PARTITION], ...sk }, sk.skEquals ? 3 : 2);
    }
  }
  if (best) return best;
  return { kind: "scan" };
}
