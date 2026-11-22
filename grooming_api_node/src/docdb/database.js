// A document database on DynamoDB that answers the MongoDB driver calls this
// application makes (find, findOne, updateOne, findOneAndUpdate, aggregate,
// transactions and so on), so routes and services run unchanged.
//
// Filters, sorts, projections, updates and aggregation pipelines are evaluated
// with mingo, a JavaScript implementation of the MongoDB query language. Data
// lives in DynamoDB: one table per collection, indexes from schema.js, unique
// constraints as guard items, and optimistic versions on every document so
// concurrent writers never overwrite each other.

import mingo from "mingo";
import {
  cloneDocument,
  decodeDocument,
  encodeDocument,
  keyPart,
  MISSING_SORT_KEY,
  newDocumentId,
  normalizeFilter,
  normalizeValue,
  readPath,
} from "./codec.js";
import { ConditionFailedError } from "./driver.js";
import { DuplicateKeyError, ImmutableFieldError, WriteConflictError } from "./errors.js";
import { conjuncts, planQuery } from "./planner.js";
import {
  COLLECTION_NAMES,
  collectionSchema,
  CONSTANT_PARTITION,
  DOCUMENT_ATTRIBUTE,
  ID_ATTRIBUTE,
  indexAttributes,
  tableNameFor,
  TTL_ATTRIBUTE,
  UNIQUE_KEY_ATTRIBUTE,
  UNIQUE_OWNER_ATTRIBUTE,
  uniqueTableName,
  VERSION_ATTRIBUTE,
} from "./schema.js";

const { Query, aggregate: runPipeline, find: mingoFind, update: applyOperators } = mingo;

const WRITE_ATTEMPTS = 10;
const TRANSACTION_ATTEMPTS = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt) {
  return Math.min(400, 10 * 2 ** attempt) + Math.floor(Math.random() * 20);
}

function hasOperators(update) {
  return update && typeof update === "object" && !Array.isArray(update)
    && Object.keys(update).some((key) => key.startsWith("$"));
}

function sameDocument(left, right) {
  return encodeDocument(left) === encodeDocument(right);
}

function matcher(filter) {
  const query = new Query(filter || {});
  return (document) => query.test(document);
}

function sortRows(rows, sort) {
  if (!sort || !Object.keys(sort).length) return rows;
  return mingoFind(rows, {}).sort(sort).all();
}

function project(rows, projection) {
  if (!projection || !Object.keys(projection).length) return rows;
  return mingoFind(rows, {}, projection).all();
}

function applyWindow(rows, { sort, skip, limit }) {
  let result = sortRows(rows, sort);
  if (skip) result = result.slice(skip);
  const size = Math.abs(Number(limit) || 0);
  if (size) result = result.slice(0, size);
  return result;
}

// Fields an upsert takes from its filter, as MongoDB does: plain equality,
// $eq, and a single-value $in.
function upsertSeed(filter) {
  const seed = {};
  for (const [field, condition] of conjuncts(filter)) {
    let value;
    let found = false;
    const operatorObject = condition && typeof condition === "object" && !Array.isArray(condition)
      && !(condition instanceof Date) && !(condition instanceof RegExp)
      && Object.keys(condition).some((key) => key.startsWith("$"));
    if (condition instanceof RegExp) {
      continue;
    } else if (!operatorObject) {
      value = condition;
      found = true;
    } else if ("$eq" in condition) {
      value = condition.$eq;
      found = true;
    } else if (Array.isArray(condition.$in) && condition.$in.length === 1) {
      [value] = condition.$in;
      found = true;
    }
    if (!found) continue;
    if (field === "_id") seed._id = value;
    else applyOperators(seed, { $set: { [field]: value } });
  }
  return seed;
}

export function applyUpdate(document, update, { isInsert = false, arrayFilters } = {}) {
  const before = cloneDocument(document);
  let next = cloneDocument(document);
  if (Array.isArray(update)) {
    [next] = runPipeline([next], update);
    next = next || {};
  } else if (hasOperators(update)) {
    const { $setOnInsert: setOnInsert, ...operators } = update;
    if (isInsert && setOnInsert) operators.$set = { ...(operators.$set || {}), ...setOnInsert };
    // MongoDB accepts $set of _id to its current value (and uses it on an
    // upsert insert); mingo refuses any _id path, so settle _id here.
    if (operators.$set && "_id" in operators.$set) {
      const { _id: requested, ...rest } = operators.$set;
      if (next._id === undefined) next._id = requested;
      else if (requested !== next._id) throw new ImmutableFieldError();
      if (Object.keys(rest).length) operators.$set = rest;
      else delete operators.$set;
    }
    if (Object.keys(operators).length) applyOperators(next, operators, arrayFilters);
  } else {
    next = { ...cloneDocument(update), _id: document._id };
  }
  if (before._id !== undefined && next._id !== before._id) throw new ImmutableFieldError();
  return { document: next, changed: !sameDocument(before, next) };
}

// ---------------------------------------------------------------------------

class DocSession {
  constructor(database) {
    this.database = database;
    this.entries = new Map();
    this.readVersions = new Map();
    this.inTransaction = true;
  }

  key(collection, id) {
    return `${collection}\u0000${id}`;
  }

  // The version of each stored document when this transaction first saw it.
  // Writing a document that changed since then is a write conflict, which is
  // how MongoDB's snapshot transactions behave.
  noteRead(collection, id, version) {
    const key = this.key(collection, id);
    if (!this.readVersions.has(key)) this.readVersions.set(key, version);
  }

  firstReadVersion(collection, id) {
    return this.readVersions.get(this.key(collection, id));
  }

  entry(collection, id) {
    return this.entries.get(this.key(collection, id));
  }

  stage(collection, id, base, current) {
    const key = this.key(collection, id);
    const existing = this.entries.get(key);
    if (existing) existing.current = current;
    else this.entries.set(key, { collection, id, base, current });
  }

  overlay(collection) {
    return [...this.entries.values()].filter((entry) => entry.collection === collection);
  }

  changes() {
    return [...this.entries.values()].filter((entry) => {
      if (!entry.base) return entry.current !== null;
      if (entry.current === null) return true;
      return !sameDocument(entry.base.doc, entry.current);
    });
  }

  // Driver API surface some code may touch.
  async endSession() {}
  async abortTransaction() {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------

class DocCursor {
  constructor(collection, filter, options = {}) {
    this.collection = collection;
    this.filter = filter;
    this.options = { ...options };
    this.mappers = [];
    this.buffer = null;
  }

  sort(spec) { this.options.sort = spec; return this; }
  skip(count) { this.options.skip = count; return this; }
  limit(count) { this.options.limit = count; return this; }
  project(projection) { this.options.projection = projection; return this; }
  map(fn) { this.mappers.push(fn); return this; }
  batchSize() { return this; }
  maxTimeMS() { return this; }
  hint() { return this; }
  collation() { return this; }
  comment() { return this; }
  allowDiskUse() { return this; }

  async toArray() {
    const rows = await this.collection.findDocuments(this.filter, this.options);
    return this.mappers.reduce((current, fn) => current.map(fn), rows);
  }

  async #load() {
    if (!this.buffer) this.buffer = await this.toArray();
  }

  async next() {
    await this.#load();
    return this.buffer.length ? this.buffer.shift() : null;
  }

  async hasNext() {
    await this.#load();
    return this.buffer.length > 0;
  }

  async forEach(fn) {
    for (const row of await this.toArray()) await fn(row);
  }

  async close() {
    this.buffer = [];
  }

  async *[Symbol.asyncIterator]() {
    for (const row of await this.toArray()) yield row;
  }
}

class AggregationCursor {
  constructor(collection, pipeline, options = {}) {
    this.collection = collection;
    this.pipeline = normalizeValue(pipeline || []);
    this.options = options;
  }

  allowDiskUse() { return this; }
  batchSize() { return this; }
  maxTimeMS() { return this; }

  async toArray() {
    const first = this.pipeline[0];
    const filter = first && first.$match ? first.$match : {};
    const records = await this.collection.database.candidates(this.collection.name, filter, this.options);
    const docs = records.map((record) => record.doc);
    return runPipeline(docs, this.pipeline);
  }

  async next() {
    if (!this.buffer) this.buffer = await this.toArray();
    return this.buffer.length ? this.buffer.shift() : null;
  }

  async close() {
    this.buffer = [];
  }

  async *[Symbol.asyncIterator]() {
    for (const row of await this.toArray()) yield row;
  }
}

// ---------------------------------------------------------------------------

class DocCollection {
  constructor(database, name) {
    collectionSchema(name);
    this.database = database;
    this.name = name;
    this.collectionName = name;
  }

  find(filter = {}, options = {}) {
    return new DocCursor(this, normalizeFilter(filter), options);
  }

  async findDocuments(filter, options = {}) {
    const records = await this.database.candidates(this.name, filter, options);
    const rows = applyWindow(records.map((record) => record.doc), options);
    return project(rows, options.projection);
  }

  async findOne(filter = {}, options = {}) {
    const rows = await this.findDocuments(normalizeFilter(filter), { ...options, limit: 1 });
    return rows[0] ?? null;
  }

  async countDocuments(filter = {}, options = {}) {
    const records = await this.database.candidates(this.name, normalizeFilter(filter), options);
    let count = records.length - (options.skip || 0);
    if (options.limit) count = Math.min(count, options.limit);
    return Math.max(0, count);
  }

  async estimatedDocumentCount() {
    return (await this.database.candidates(this.name, {}, {})).length;
  }

  async distinct(field, filter = {}, options = {}) {
    const records = await this.database.candidates(this.name, normalizeFilter(filter), options);
    const seen = new Map();
    for (const { doc } of records) {
      const value = readPath(doc, field);
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item === undefined) continue;
        seen.set(encodeDocument({ v: item }), item);
      }
    }
    return [...seen.values()];
  }

  aggregate(pipeline = [], options = {}) {
    return new AggregationCursor(this, pipeline, options);
  }

  async insertOne(document, options = {}) {
    if (document._id === undefined || document._id === null) document._id = newDocumentId();
    const normalized = normalizeValue(document);
    if (typeof normalized._id !== "string") {
      throw new TypeError(`DynamoDB documents need a string _id; got ${typeof normalized._id}`);
    }
    await this.database.insert(this.name, normalized, options.session);
    return { acknowledged: true, insertedId: normalized._id };
  }

  async insertMany(documents, options = {}) {
    const insertedIds = {};
    for (const [index, document] of documents.entries()) {
      const result = await this.insertOne(document, options);
      insertedIds[index] = result.insertedId;
    }
    return { acknowledged: true, insertedCount: documents.length, insertedIds };
  }

  async updateOne(filter, update, options = {}) {
    const result = await this.database.mutateOne(this.name, normalizeFilter(filter), {
      update: normalizeValue(update),
      upsert: options.upsert,
      arrayFilters: options.arrayFilters ? normalizeValue(options.arrayFilters) : undefined,
      sort: options.sort,
      session: options.session,
    });
    return {
      acknowledged: true,
      matchedCount: result.matched,
      modifiedCount: result.modified,
      upsertedCount: result.upsertedId ? 1 : 0,
      upsertedId: result.upsertedId ?? null,
    };
  }

  async replaceOne(filter, replacement, options = {}) {
    return this.updateOne(filter, replacement, options);
  }

  async updateMany(filter, update, options = {}) {
    const normalizedFilter = normalizeFilter(filter);
    const normalizedUpdate = normalizeValue(update);
    const records = await this.database.candidates(this.name, normalizedFilter, { ...options, consistent: true });
    let matched = 0;
    let modified = 0;
    for (const { doc } of records) {
      const result = await this.database.mutateOne(this.name, { $and: [{ _id: doc._id }, normalizedFilter] }, {
        update: normalizedUpdate,
        arrayFilters: options.arrayFilters ? normalizeValue(options.arrayFilters) : undefined,
        session: options.session,
      });
      matched += result.matched;
      modified += result.modified;
    }
    if (!records.length && options.upsert) {
      const result = await this.database.mutateOne(this.name, normalizedFilter, {
        update: normalizedUpdate,
        upsert: true,
        session: options.session,
      });
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: result.upsertedId };
    }
    return { acknowledged: true, matchedCount: matched, modifiedCount: modified, upsertedCount: 0, upsertedId: null };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const result = await this.database.mutateOne(this.name, normalizeFilter(filter), {
      update: normalizeValue(update),
      upsert: options.upsert,
      arrayFilters: options.arrayFilters ? normalizeValue(options.arrayFilters) : undefined,
      sort: options.sort,
      session: options.session,
    });
    const chosen = options.returnDocument === "after" || options.returnOriginal === false
      ? result.after
      : result.before;
    const value = chosen ? project([chosen], options.projection)[0] : null;
    if (options.includeResultMetadata) return { value, ok: 1 };
    return value;
  }

  async findOneAndReplace(filter, replacement, options = {}) {
    return this.findOneAndUpdate(filter, replacement, options);
  }

  async findOneAndDelete(filter, options = {}) {
    const result = await this.database.mutateOne(this.name, normalizeFilter(filter), {
      remove: true,
      sort: options.sort,
      session: options.session,
    });
    const value = result.before ? project([result.before], options.projection)[0] : null;
    if (options.includeResultMetadata) return { value, ok: 1 };
    return value;
  }

  async deleteOne(filter, options = {}) {
    const result = await this.database.mutateOne(this.name, normalizeFilter(filter), {
      remove: true,
      session: options.session,
    });
    return { acknowledged: true, deletedCount: result.matched };
  }

  async deleteMany(filter, options = {}) {
    const normalizedFilter = normalizeFilter(filter);
    const records = await this.database.candidates(this.name, normalizedFilter, { ...options, consistent: true });
    let deleted = 0;
    for (const { doc } of records) {
      const result = await this.database.mutateOne(this.name, { $and: [{ _id: doc._id }, normalizedFilter] }, {
        remove: true,
        session: options.session,
      });
      deleted += result.matched;
    }
    return { acknowledged: true, deletedCount: deleted };
  }

  async bulkWrite(operations, options = {}) {
    const summary = {
      acknowledged: true,
      insertedCount: 0,
      matchedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      upsertedCount: 0,
      insertedIds: {},
      upsertedIds: {},
    };
    const errors = [];
    for (const [index, operation] of operations.entries()) {
      try {
        if (operation.insertOne) {
          const result = await this.insertOne(operation.insertOne.document, options);
          summary.insertedCount += 1;
          summary.insertedIds[index] = result.insertedId;
        } else if (operation.updateOne || operation.replaceOne) {
          const spec = operation.updateOne || operation.replaceOne;
          const result = await this.updateOne(spec.filter, spec.update ?? spec.replacement, {
            ...options,
            upsert: spec.upsert,
            arrayFilters: spec.arrayFilters,
          });
          summary.matchedCount += result.matchedCount;
          summary.modifiedCount += result.modifiedCount;
          if (result.upsertedId) {
            summary.upsertedCount += 1;
            summary.upsertedIds[index] = result.upsertedId;
          }
        } else if (operation.updateMany) {
          const spec = operation.updateMany;
          const result = await this.updateMany(spec.filter, spec.update, { ...options, upsert: spec.upsert });
          summary.matchedCount += result.matchedCount;
          summary.modifiedCount += result.modifiedCount;
          if (result.upsertedId) {
            summary.upsertedCount += 1;
            summary.upsertedIds[index] = result.upsertedId;
          }
        } else if (operation.deleteOne) {
          summary.deletedCount += (await this.deleteOne(operation.deleteOne.filter, options)).deletedCount;
        } else if (operation.deleteMany) {
          summary.deletedCount += (await this.deleteMany(operation.deleteMany.filter, options)).deletedCount;
        } else {
          throw new Error(`Unsupported bulkWrite operation ${Object.keys(operation)[0]}`);
        }
      } catch (error) {
        if (options.ordered !== false) throw error;
        errors.push({ index, error });
      }
    }
    if (errors.length) {
      const error = errors[0].error;
      error.writeErrors = errors;
      error.result = summary;
      throw error;
    }
    return summary;
  }

  // Index management belongs to DynamoDB table definitions (schema.js).
  async createIndex(key, options = {}) {
    return options.name || Object.entries(key).map(([field, order]) => `${field}_${order}`).join("_");
  }

  async createIndexes(specs) {
    return specs.map((spec) => spec.name);
  }

  async dropIndex() {}

  listIndexes() {
    return { toArray: async () => [] };
  }

  async indexes() {
    return [];
  }
}

// ---------------------------------------------------------------------------

export class DynamoDocumentDatabase {
  constructor({ driver, tablePrefix = "facultytrack-", now = () => Date.now(), logScans = false }) {
    this.driver = driver;
    this.prefix = tablePrefix;
    this.now = now;
    this.logScans = logScans;
    this.collections = new Map();
    this.databaseName = `${tablePrefix}db`;
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new DocCollection(this, name));
    return this.collections.get(name);
  }

  async command(command) {
    if (command?.ping) {
      await this.driver.ping(tableNameFor(this.prefix, COLLECTION_NAMES[0]));
      return { ok: 1 };
    }
    throw new Error(`Command ${Object.keys(command || {})[0]} is not supported on DynamoDB`);
  }

  async withTransaction(work) {
    for (let attempt = 0; ; attempt += 1) {
      const session = new DocSession(this);
      try {
        const result = await work(session);
        await this.commitSession(session);
        return result;
      } catch (error) {
        if (error instanceof WriteConflictError && attempt < TRANSACTION_ATTEMPTS - 1) {
          await sleep(backoff(attempt));
          continue;
        }
        throw error;
      }
    }
  }

  // ---- storage helpers ----

  table(collection) {
    collectionSchema(collection);
    return tableNameFor(this.prefix, collection);
  }

  isExpired(collection, document) {
    const field = collectionSchema(collection).ttlField;
    if (!field) return false;
    const value = document?.[field];
    return value instanceof Date && value.getTime() <= this.now();
  }

  toItem(collection, document, version) {
    const schema = collectionSchema(collection);
    const item = {
      [ID_ATTRIBUTE]: document._id,
      [DOCUMENT_ATTRIBUTE]: encodeDocument(document),
      [VERSION_ATTRIBUTE]: version,
    };
    const expiry = schema.ttlField ? document[schema.ttlField] : null;
    if (expiry instanceof Date && !Number.isNaN(expiry.getTime())) {
      item[TTL_ATTRIBUTE] = Math.floor(expiry.getTime() / 1000);
    }
    for (const index of schema.indexes) {
      const names = indexAttributes(index);
      if (index.sparseOn && readPath(document, index.sparseOn) === undefined) continue;
      let partition = CONSTANT_PARTITION;
      if (index.pk) {
        partition = keyPart(readPath(document, index.pk));
        if (partition === null) continue;
      }
      item[names.pk] = partition;
      if (names.sk) item[names.sk] = keyPart(readPath(document, index.sk)) ?? MISSING_SORT_KEY;
    }
    return item;
  }

  fromItem(item) {
    return { doc: decodeDocument(item[DOCUMENT_ATTRIBUTE]), version: Number(item[VERSION_ATTRIBUTE]) || 0 };
  }

  async readById(collection, id, { consistent = false } = {}) {
    const item = await this.driver.getItem(this.table(collection), ID_ATTRIBUTE, id, { consistent });
    return item ? this.fromItem(item) : null;
  }

  uniqueKeys(collection, document) {
    const keys = new Map();
    if (!document) return keys;
    for (const constraint of collectionSchema(collection).unique) {
      const values = constraint.fields.map((field) => {
        const value = readPath(document, field);
        return value === undefined ? null : value;
      });
      if (constraint.requireStrings && !values.every((value) => typeof value === "string")) continue;
      keys.set(this.uniqueKey(collection, constraint, values), { constraint, values });
    }
    return keys;
  }

  uniqueKey(collection, constraint, values) {
    const canonical = values.map((value) => {
      if (typeof value === "string" && constraint.casefold) return value.toLocaleLowerCase("en-US");
      if (value instanceof Date) return { $date: value.getTime() };
      return value;
    });
    return `${collection}#${constraint.name}#${JSON.stringify(canonical)}`;
  }

  // ---- reads ----

  async fetchRecords(collection, plan, { consistent, filter }) {
    const table = this.table(collection);
    if (plan.kind === "empty") return [];
    if (plan.kind === "ids") {
      const items = await this.driver.batchGetItems(table, ID_ATTRIBUTE, plan.ids, { consistent });
      return items.map((item) => this.fromItem(item));
    }
    if (plan.kind === "unique") {
      const key = this.uniqueKey(collection, plan.constraint, plan.values);
      const marker = await this.driver.getItem(uniqueTableName(this.prefix), UNIQUE_KEY_ATTRIBUTE, key, { consistent });
      if (marker) {
        const record = await this.readById(collection, marker[UNIQUE_OWNER_ATTRIBUTE], { consistent });
        if (record && this.uniqueKeys(collection, record.doc).has(key)) return [record];
      }
      return null;
    }
    if (plan.kind === "index") {
      const names = indexAttributes(plan.index);
      const batches = await Promise.all(plan.pkValues.map((pkValue) => this.driver.queryIndex(table, {
        indexName: plan.index.name,
        pkAttr: names.pk,
        pkValue,
        skAttr: names.sk,
        skFrom: plan.skFrom,
        skTo: plan.skTo,
        skEquals: plan.skEquals,
      })));
      const byId = new Map();
      for (const item of batches.flat()) byId.set(item[ID_ATTRIBUTE], item);
      if (consistent && byId.size) {
        const fresh = await this.driver.batchGetItems(table, ID_ATTRIBUTE, [...byId.keys()], { consistent: true });
        return fresh.map((item) => this.fromItem(item));
      }
      return [...byId.values()].map((item) => this.fromItem(item));
    }
    if (this.logScans) {
      const shape = JSON.stringify(filter || {}, (key, value) => (
        value && typeof value === "object" ? value : (key.startsWith("$") || key === "" ? value : "?")
      ));
      console.warn(`[docdb] full table read of ${collection} for ${shape}`);
    }
    const items = await this.driver.scanTable(table, { consistent });
    return items.map((item) => this.fromItem(item));
  }

  // Stored records that match the filter, as { doc, version }. Inside a
  // transaction the session's own uncommitted changes are applied on top.
  async candidates(collection, filter, { session, consistent = false } = {}) {
    const schema = collectionSchema(collection);
    const readConsistent = consistent || Boolean(session);
    let plan = planQuery(schema, filter);
    let records = await this.fetchRecords(collection, plan, { consistent: readConsistent, filter });
    if (records === null) {
      plan = planQuery({ ...schema, unique: [] }, filter);
      records = await this.fetchRecords(collection, plan, { consistent: readConsistent, filter });
    }
    const matches = matcher(filter);
    let result = records.filter((record) => !this.isExpired(collection, record.doc));
    if (session) {
      for (const record of result) session.noteRead(collection, record.doc._id, record.version);
      const overlay = new Map(session.overlay(collection).map((entry) => [entry.id, entry]));
      result = result
        .filter((record) => !overlay.has(record.doc._id))
        .concat([...overlay.values()]
          .filter((entry) => entry.current !== null)
          .map((entry) => ({ doc: cloneDocument(entry.current), version: entry.base?.version ?? 0 })));
    }
    return result.filter((record) => matches(record.doc));
  }

  // ---- writes ----

  async insert(collection, document, session) {
    if (session) {
      const staged = session.entry(collection, document._id);
      if (staged && staged.current !== null) {
        throw new DuplicateKeyError(collection, "_id_", ["_id"], [document._id]);
      }
      const stored = staged ? staged.base : await this.readById(collection, document._id, { consistent: true });
      if (!staged && stored && !this.isExpired(collection, stored.doc)) {
        throw new DuplicateKeyError(collection, "_id_", ["_id"], [document._id]);
      }
      await this.checkUnique(collection, document._id, staged?.current ?? stored?.doc ?? null, document, session);
      session.stage(collection, document._id, stored, cloneDocument(document));
      return;
    }
    let before = null;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      try {
        await this.commit([{ collection, id: document._id, before, after: document }]);
        return;
      } catch (error) {
        if (!(error instanceof WriteConflictError)) throw error;
        const existing = await this.readById(collection, document._id, { consistent: true });
        if (existing && !this.isExpired(collection, existing.doc)) {
          throw new DuplicateKeyError(collection, "_id_", ["_id"], [document._id]);
        }
        before = existing;
        await sleep(backoff(attempt));
      }
    }
    throw new WriteConflictError(`Could not insert into ${collection} after ${WRITE_ATTEMPTS} attempts`);
  }

  async mutateOne(collection, filter, { update, upsert = false, remove = false, arrayFilters, sort, session }) {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const records = await this.candidates(collection, filter, { session, consistent: true });
      const [target] = sort ? sortRecords(records, sort) : records;
      let change;
      let outcome;
      if (!target) {
        if (!upsert || remove) return { matched: 0, modified: 0, before: null, after: null };
        // The new document's id comes from the filter, or else from $set or
        // $setOnInsert (as when saveEvaluation supplies one); only when
        // neither gives one is an id generated.
        const seed = upsertSeed(filter);
        const { document } = applyUpdate(seed, update, { isInsert: true, arrayFilters });
        if (document._id === undefined || document._id === null) document._id = newDocumentId();
        if (typeof document._id !== "string") throw new TypeError("DynamoDB documents need a string _id");
        const stored = session?.entry(collection, document._id)?.base
          ?? await this.readById(collection, document._id, { consistent: true });
        if (stored && !this.isExpired(collection, stored.doc) && !session?.entry(collection, document._id)) {
          throw new DuplicateKeyError(collection, "_id_", ["_id"], [document._id]);
        }
        change = { collection, id: document._id, before: stored, after: document };
        outcome = { matched: 0, modified: 0, upsertedId: document._id, before: null, after: document };
      } else if (remove) {
        change = { collection, id: target.doc._id, before: target, after: null };
        outcome = { matched: 1, modified: 0, before: target.doc, after: null };
      } else {
        const { document, changed } = applyUpdate(target.doc, update, { arrayFilters });
        if (!changed) return { matched: 1, modified: 0, before: target.doc, after: target.doc };
        change = { collection, id: target.doc._id, before: target, after: document };
        outcome = { matched: 1, modified: 1, before: target.doc, after: document };
      }

      if (session) {
        const staged = session.entry(collection, change.id);
        if (!staged) {
          const seen = session.firstReadVersion(collection, change.id);
          if (seen !== undefined && seen !== (change.before?.version ?? null)) throw new WriteConflictError();
        }
        await this.checkUnique(collection, change.id, change.before?.doc ?? null, change.after, session);
        session.stage(collection, change.id, staged ? staged.base : change.before, change.after && cloneDocument(change.after));
        return outcome;
      }
      try {
        await this.commit([change]);
        return outcome;
      } catch (error) {
        if (!(error instanceof WriteConflictError)) throw error;
        await sleep(backoff(attempt));
      }
    }
    throw new WriteConflictError(`Could not update ${collection} after ${WRITE_ATTEMPTS} attempts`);
  }

  // Fails early, inside a transaction, when a change would break a unique
  // constraint, so the caller sees the duplicate at the statement that caused
  // it, as with MongoDB.
  async checkUnique(collection, id, before, after, session) {
    if (!after) return;
    const previous = this.uniqueKeys(collection, before);
    for (const [key, { constraint, values }] of this.uniqueKeys(collection, after)) {
      if (previous.has(key)) continue;
      for (const entry of session.overlay(collection)) {
        if (entry.id !== id && entry.current && this.uniqueKeys(collection, entry.current).has(key)) {
          throw new DuplicateKeyError(collection, constraint.name, constraint.fields, values);
        }
      }
      const owner = await this.markerOwner(collection, key);
      if (owner && owner !== id) {
        const staged = session.entry(collection, owner);
        if (staged) {
          if (staged.current && this.uniqueKeys(collection, staged.current).has(key)) {
            throw new DuplicateKeyError(collection, constraint.name, constraint.fields, values);
          }
          continue;
        }
        if (await this.ownerHoldsKey(collection, owner, key)) {
          throw new DuplicateKeyError(collection, constraint.name, constraint.fields, values);
        }
      }
    }
  }

  async markerOwner(collection, key) {
    const marker = await this.driver.getItem(uniqueTableName(this.prefix), UNIQUE_KEY_ATTRIBUTE, key, { consistent: true });
    return marker ? marker[UNIQUE_OWNER_ATTRIBUTE] : null;
  }

  async ownerHoldsKey(collection, owner, key) {
    const record = await this.readById(collection, owner, { consistent: true });
    return Boolean(record) && !this.isExpired(collection, record.doc) && this.uniqueKeys(collection, record.doc).has(key);
  }

  async commitSession(session) {
    const changes = session.changes().map((entry) => ({
      collection: entry.collection,
      id: entry.id,
      before: entry.base,
      after: entry.current,
    }));
    if (changes.length) await this.commit(changes);
  }

  // Writes a set of document changes, with their unique guards, atomically.
  //
  // Guards are worked out in two passes: first every guard a change gives up,
  // then every guard a change takes. A guard released by one change and taken
  // by another in the same commit becomes a single owner hand-over, because
  // DynamoDB refuses two operations on one item in a transaction.
  async commit(changes) {
    const uniqueTable = uniqueTableName(this.prefix);
    const documentActions = [];
    const releases = new Map();
    const claims = [];
    for (const change of changes) {
      const table = this.table(change.collection);
      const { before, after, id } = change;
      if (after) {
        documentActions.push({
          op: "put",
          table,
          item: this.toItem(change.collection, after, (before?.version ?? 0) + 1),
          condition: before
            ? { equals: { attr: VERSION_ATTRIBUTE, value: before.version } }
            : { absent: ID_ATTRIBUTE },
        });
      } else if (before) {
        documentActions.push({
          op: "delete",
          table,
          key: { name: ID_ATTRIBUTE, value: id },
          condition: { equals: { attr: VERSION_ATTRIBUTE, value: before.version } },
        });
      } else {
        continue;
      }
      const ttlField = collectionSchema(change.collection).ttlField;
      const previous = this.uniqueKeys(change.collection, before?.doc);
      const next = this.uniqueKeys(change.collection, after);
      for (const key of previous.keys()) {
        if (!next.has(key)) releases.set(key, id);
      }
      for (const [key, detail] of next) {
        if (previous.has(key) && !ttlField) continue;
        claims.push({ key, id, collection: change.collection, after, ttlField, ...detail });
      }
    }

    const claimActions = [];
    const claimedBy = new Map();
    for (const claim of claims) {
      const { key, id, collection, constraint, values, ttlField, after } = claim;
      if (claimedBy.has(key) && claimedBy.get(key) !== id) {
        throw new DuplicateKeyError(collection, constraint.name, constraint.fields, values);
      }
      claimedBy.set(key, id);
      let condition;
      if (releases.has(key)) {
        condition = { equals: { attr: UNIQUE_OWNER_ATTRIBUTE, value: releases.get(key) } };
        releases.delete(key);
      } else {
        const owner = await this.markerOwner(collection, key);
        if (!owner) {
          condition = { absent: UNIQUE_KEY_ATTRIBUTE };
        } else if (owner === id) {
          condition = { equals: { attr: UNIQUE_OWNER_ATTRIBUTE, value: id } };
        } else if (await this.ownerHoldsKey(collection, owner, key)) {
          throw new DuplicateKeyError(collection, constraint.name, constraint.fields, values);
        } else {
          // The guard outlived its document (expired or removed): take it over.
          condition = { equals: { attr: UNIQUE_OWNER_ATTRIBUTE, value: owner } };
        }
      }
      const marker = { [UNIQUE_KEY_ATTRIBUTE]: key, [UNIQUE_OWNER_ATTRIBUTE]: id };
      const expiry = ttlField ? after[ttlField] : null;
      if (expiry instanceof Date && !Number.isNaN(expiry.getTime())) {
        marker[TTL_ATTRIBUTE] = Math.floor(expiry.getTime() / 1000);
      }
      claimActions.push({ op: "put", table: uniqueTable, item: marker, condition });
    }
    const releaseActions = [...releases].map(([key, owner]) => ({
      op: "delete",
      table: uniqueTable,
      key: { name: UNIQUE_KEY_ATTRIBUTE, value: key },
      condition: { equals: { attr: UNIQUE_OWNER_ATTRIBUTE, value: owner } },
    }));

    const actions = [...documentActions, ...releaseActions, ...claimActions];
    if (!actions.length) return;
    try {
      await this.driver.write(actions);
    } catch (error) {
      if (error instanceof ConditionFailedError) throw new WriteConflictError();
      throw error;
    }
  }
}

function sortRecords(records, sort) {
  const order = sortRows(records.map((record) => record.doc), sort);
  const byId = new Map(records.map((record) => [record.doc._id, record]));
  return order.map((doc) => byId.get(doc._id));
}
