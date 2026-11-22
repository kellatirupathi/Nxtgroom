// Table setup, MongoDB -> DynamoDB copy, and verification for src/docdb.

import { encodeDocument, normalizeValue } from "./codec.js";
import {
  allTableDefinitions,
  COLLECTION_NAMES,
  TTL_ATTRIBUTE,
  UNIQUE_KEY_ATTRIBUTE,
  UNIQUE_OWNER_ATTRIBUTE,
  uniqueTableName,
} from "./schema.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Table setup calls are rate-limited by AWS, and some are refused while a new
// table settles. Those answers mean "try again shortly", so wait and retry.
const RETRYABLE = /rate exceeded|throttl|LimitExceeded|being enabled|retry later|ContinuousBackupsUnavailable|ResourceInUse|CREATING state/i;

async function patiently(work, { attempts = 30, delayMs = 10000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!RETRYABLE.test(`${error?.name || ""} ${error?.message || ""}`) || attempt >= attempts) throw error;
      await sleep(delayMs);
    }
  }
}

async function waitForActive(driver, tableName, { timeoutMs = 300000 } = {}) {
  const started = Date.now();
  for (;;) {
    const table = await patiently(() => driver.describeTable(tableName));
    const ready = table?.TableStatus === "ACTIVE"
      && (table.GlobalSecondaryIndexes || []).every((index) => !index.IndexStatus || index.IndexStatus === "ACTIVE");
    if (ready) return;
    if (Date.now() - started > timeoutMs) throw new Error(`${tableName} did not become ACTIVE in time`);
    await sleep(3000);
  }
}

// Reports which tables, indexes and TTL settings are missing; with apply,
// creates them. Existing tables are never changed or deleted.
export async function ensureTables(driver, prefix, { apply = false, pointInTimeRecovery = true, log = () => {} } = {}) {
  const report = [];
  for (const { collection, definition, ttl } of allTableDefinitions(prefix)) {
    const name = definition.TableName;
    let existing = await patiently(() => driver.describeTable(name));
    // A table (or one of its indexes) still being built answers no other
    // setup calls, so wait until AWS reports it ready.
    const building = existing && (existing.TableStatus !== "ACTIVE"
      || (existing.GlobalSecondaryIndexes || []).some((index) => index.IndexStatus && index.IndexStatus !== "ACTIVE"));
    if (building) {
      log(`Waiting for ${name} to finish building`);
      await waitForActive(driver, name);
      existing = await patiently(() => driver.describeTable(name));
    }
    const entry = { collection, table: name, status: "ok", actions: [] };
    if (!existing) {
      entry.status = "missing";
      if (apply) {
        log(`Creating ${name}`);
        await patiently(() => driver.createTable(definition));
        await waitForActive(driver, name);
        entry.actions.push("created");
      }
    } else {
      const have = new Set((existing.GlobalSecondaryIndexes || []).map((index) => index.IndexName));
      const lacking = (definition.GlobalSecondaryIndexes || []).filter((index) => !have.has(index.IndexName));
      if (lacking.length) {
        entry.status = "index_missing";
        entry.missingIndexes = lacking.map((index) => index.IndexName);
      }
    }
    if ((existing || apply) && ttl) {
      const enabled = existing || entry.actions.includes("created") ? await patiently(() => driver.ttlEnabled(name)) : false;
      if (!enabled) {
        if (apply) {
          await patiently(() => driver.enableTtl(name, TTL_ATTRIBUTE));
          entry.actions.push("ttl_enabled");
        } else if (entry.status === "ok") {
          entry.status = "ttl_missing";
        }
      }
    }
    // Turning backups on is safe to repeat, so it runs for every table on
    // apply; a table created a moment ago may refuse it for a while.
    if (apply && pointInTimeRecovery) {
      await patiently(() => driver.enablePointInTimeRecovery(name), { attempts: 40, delayMs: 15000 });
      entry.actions.push("backups_on");
    }
    report.push(entry);
  }
  return report;
}

async function mapLimit(items, limit, work) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await work(items[index], index);
    }
  });
  await Promise.all(workers);
}

// Copies every document from a MongoDB database into the DynamoDB store.
// Running it again updates documents in place, so it is safe to repeat.
// With prune, documents that exist only in DynamoDB (deleted from MongoDB
// since an earlier copy) are removed, so the copy ends up an exact mirror.
export async function copyCollections(sourceDb, target, {
  collections = COLLECTION_NAMES,
  concurrency = 16,
  prune = false,
  log = () => {},
} = {}) {
  const summary = [];
  for (const name of collections) {
    const documents = (await sourceDb.collection(name).find({}).toArray()).map(normalizeValue);
    let written = 0;
    let unchanged = 0;
    await mapLimit(documents, concurrency, async (document) => {
      if (typeof document._id !== "string") {
        throw new Error(`${name} has a document whose _id is ${typeof document._id}; only strings and ObjectIds are supported`);
      }
      for (let attempt = 0; ; attempt += 1) {
        const existing = await target.readById(name, document._id, { consistent: true });
        if (existing && encodeDocument(existing.doc) === encodeDocument(document)) {
          unchanged += 1;
          return;
        }
        try {
          await target.commit([{ collection: name, id: document._id, before: existing, after: document }]);
          written += 1;
          return;
        } catch (error) {
          if (error?.name !== "WriteConflictError" || attempt >= 5) throw error;
          await sleep(100 * (attempt + 1));
        }
      }
    });
    let removed = 0;
    if (prune) {
      const keep = new Set(documents.map((document) => document._id));
      const stale = (await target.driver.scanTable(target.table(name), { consistent: true }))
        .map((item) => target.fromItem(item))
        .filter((record) => !keep.has(record.doc._id));
      await mapLimit(stale, concurrency, async (record) => {
        await target.commit([{ collection: name, id: record.doc._id, before: record, after: null }]);
        removed += 1;
      });
    }
    summary.push({ collection: name, source: documents.length, written, unchanged, removed });
    log(`${name}: ${documents.length} document(s), ${written} written, ${unchanged} already up to date`
      + (prune ? `, ${removed} removed` : ""));
  }
  return summary;
}

// Compares every document field by field. Ids are compared as strings, since
// ObjectIds are stored in their hex form.
export async function verifyCollections(sourceDb, target, { collections = COLLECTION_NAMES } = {}) {
  const results = [];
  for (const name of collections) {
    const source = new Map((await sourceDb.collection(name).find({}).toArray())
      .map((document) => normalizeValue(document))
      .map((document) => [document._id, encodeDocument(document)]));
    const storedDocs = (await target.driver.scanTable(target.table(name), { consistent: true }))
      .map((item) => target.fromItem(item).doc);
    const stored = new Map(storedDocs.map((document) => [document._id, encodeDocument(document)]));
    const missing = [...source.keys()].filter((id) => !stored.has(id));
    const different = [...source.keys()].filter((id) => stored.has(id) && stored.get(id) !== source.get(id));
    const extra = [...stored.keys()].filter((id) => !source.has(id));

    // Every unique guard must exist and point at its document.
    const expected = new Map();
    for (const document of storedDocs) {
      for (const key of target.uniqueKeys(name, document).keys()) expected.set(key, document._id);
    }
    const guards = expected.size
      ? await target.driver.batchGetItems(uniqueTableName(target.prefix), UNIQUE_KEY_ATTRIBUTE, [...expected.keys()], { consistent: true })
      : [];
    const owners = new Map(guards.map((guard) => [guard[UNIQUE_KEY_ATTRIBUTE], guard[UNIQUE_OWNER_ATTRIBUTE]]));
    const badGuards = [...expected].filter(([key, id]) => owners.get(key) !== id).length;

    results.push({
      collection: name,
      source: source.size,
      dynamodb: stored.size,
      missing: missing.length,
      different: different.length,
      extra: extra.length,
      unique_guards: expected.size,
      bad_guards: badGuards,
      examples: [...missing, ...different].slice(0, 3),
      ok: !missing.length && !different.length && !badGuards,
    });
  }
  return results;
}
