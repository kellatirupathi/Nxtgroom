import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAILY_ATTENDANCE_INDEX,
  LEGACY_DAILY_ATTENDANCE_FILTER,
  migrateLegacyDailyAttendanceIndex,
  WIDENED_DAILY_ATTENDANCE_INDEX,
} from "../src/config/databasePreflight.js";

function fakeCollection(initialIndexes) {
  const indexes = [...initialIndexes];
  const created = [];
  const dropped = [];
  return {
    created,
    dropped,
    indexes,
    listIndexes() {
      return { toArray: async () => indexes.map((index) => ({ ...index })) };
    },
    async createIndex(key, options) {
      created.push({ key, options });
      indexes.push({ name: options.name, key, ...options });
      return options.name;
    },
    async dropIndex(name) {
      const position = indexes.findIndex((index) => index.name === name);
      if (position === -1) {
        throw Object.assign(new Error("index not found"), { code: 27, codeName: "IndexNotFound" });
      }
      indexes.splice(position, 1);
      dropped.push(name);
    },
  };
}

const fakeDb = (collection) => ({ collection: () => collection });

const legacyIndex = {
  name: "one_attendance_per_day",
  key: { instructor_id: 1, attendance_day: 1 },
  unique: true,
  partialFilterExpression: LEGACY_DAILY_ATTENDANCE_FILTER,
};

const currentIndex = {
  name: "one_attendance_per_day",
  key: { instructor_id: 1, attendance_day: 1 },
  unique: true,
  partialFilterExpression: WIDENED_DAILY_ATTENDANCE_INDEX.options.partialFilterExpression,
};

test("the API requires the widened daily attendance index", () => {
  assert.deepEqual(
    DAILY_ATTENDANCE_INDEX.options.partialFilterExpression,
    WIDENED_DAILY_ATTENDANCE_INDEX.options.partialFilterExpression
  );
  assert.deepEqual(
    DAILY_ATTENDANCE_INDEX.options.partialFilterExpression.instructor_id,
    { $type: "string" }
  );
  assert.equal(DAILY_ATTENDANCE_INDEX.options.unique, true);
});

test("the migration target requires a string instructor_id, not only a day", () => {
  const filter = WIDENED_DAILY_ATTENDANCE_INDEX.options.partialFilterExpression;
  assert.deepEqual(filter.instructor_id, { $type: "string" });
  assert.deepEqual(filter.attendance_day, { $type: "string" });
  assert.equal(WIDENED_DAILY_ATTENDANCE_INDEX.options.unique, true);
});

test("unidentified records fall outside the widened rule, real ones inside it", () => {
  const filter = WIDENED_DAILY_ATTENDANCE_INDEX.options.partialFilterExpression;
  const covered = (record) => (
    typeof record.instructor_id === "string" && typeof record.attendance_day === "string"
  );
  assert.ok(filter.instructor_id, "the filter must constrain instructor_id");

  const day = "2026-09-11";
  assert.equal(covered({ instructor_id: "abc", attendance_day: day }), true);
  assert.equal(covered({ instructor_id: null, attendance_day: day }), false);
  assert.equal(covered({ attendance_day: day }), false);
});

test("unidentified check-ins do not collide under the required index", () => {
  const filter = DAILY_ATTENDANCE_INDEX.options.partialFilterExpression;
  assert.deepEqual(filter.instructor_id, { $type: "string" });
  const coveredByCurrentIndex = (record) => (
    typeof record.instructor_id === "string" && typeof record.attendance_day === "string"
  );
  assert.equal(coveredByCurrentIndex({ instructor_id: null, attendance_day: "2026-09-11" }), false);
});

test("migrating replaces the legacy filter without recreating an equivalent index", async () => {
  const collection = fakeCollection([legacyIndex]);
  const result = await migrateLegacyDailyAttendanceIndex(fakeDb(collection));

  assert.equal(result.migrated, true);
  assert.equal(result.created, true);
  assert.deepEqual(result.dropped, ["one_attendance_per_day"]);

  const remaining = collection.indexes.filter((index) => (
    index.name === `${WIDENED_DAILY_ATTENDANCE_INDEX.options.name}_migrating`
  ));
  assert.equal(remaining.length, 1);
  assert.deepEqual(
    remaining[0].partialFilterExpression,
    WIDENED_DAILY_ATTENDANCE_INDEX.options.partialFilterExpression
  );
  assert.equal(collection.created.length, 1);
});

test("the replacement is created before the legacy index is dropped", async () => {
  const collection = fakeCollection([legacyIndex]);
  const order = [];
  const createIndex = collection.createIndex.bind(collection);
  const dropIndex = collection.dropIndex.bind(collection);
  collection.createIndex = async (key, options) => {
    order.push(`create:${options.name}`);
    return createIndex(key, options);
  };
  collection.dropIndex = async (name) => {
    order.push(`drop:${name}`);
    return dropIndex(name);
  };

  await migrateLegacyDailyAttendanceIndex(fakeDb(collection));

  const firstCreate = order.findIndex((step) => step.startsWith("create:"));
  const firstDrop = order.findIndex((step) => step.startsWith("drop:"));
  assert.ok(firstCreate !== -1 && firstDrop !== -1);
  assert.ok(firstCreate < firstDrop, `expected a create before any drop, got ${order.join(" -> ")}`);
});

test("migrating is a no-op when the index is already correct", async () => {
  const collection = fakeCollection([currentIndex]);
  const result = await migrateLegacyDailyAttendanceIndex(fakeDb(collection));

  assert.equal(result.migrated, false);
  assert.equal(result.created, false);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(collection.created, []);
  assert.deepEqual(collection.dropped, []);
});

test("migrating twice leaves the same single index", async () => {
  const collection = fakeCollection([legacyIndex]);
  await migrateLegacyDailyAttendanceIndex(fakeDb(collection));
  const second = await migrateLegacyDailyAttendanceIndex(fakeDb(collection));

  assert.equal(second.migrated, false);
  const matching = collection.indexes.filter((index) => (
    index.unique === true
    && JSON.stringify(index.key) === JSON.stringify(WIDENED_DAILY_ATTENDANCE_INDEX.key)
    && JSON.stringify(index.partialFilterExpression)
      === JSON.stringify(WIDENED_DAILY_ATTENDANCE_INDEX.options.partialFilterExpression)
  ));
  assert.equal(matching.length, 1);
});

test("an unrelated attendance index is left alone", async () => {
  const unrelated = {
    name: "instructor_id_1_check_in_time_-1",
    key: { instructor_id: 1, check_in_time: -1 },
  };
  const collection = fakeCollection([legacyIndex, unrelated]);
  await migrateLegacyDailyAttendanceIndex(fakeDb(collection));

  assert.ok(collection.indexes.some((index) => index.name === unrelated.name));
  assert.equal(collection.dropped.includes(unrelated.name), false);
});
