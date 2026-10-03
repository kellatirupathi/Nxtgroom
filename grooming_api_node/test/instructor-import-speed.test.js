import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  commitImportRows,
  createKeyedLock,
  createLimiter,
  PhotoCache,
  previewImportRows,
} from "../src/services/instructorImport.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a limiter never runs more than its maximum at once, and runs everything", async () => {
  const limit = createLimiter(3);
  let active = 0;
  let peak = 0;
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => limit(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(5);
    active -= 1;
    return index;
  })));
  assert.equal(peak, 3);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("a failing task does not stall the limiter", async () => {
  const limit = createLimiter(1);
  await assert.rejects(limit(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await limit(async () => "next"), "next");
});

test("tasks for one key run in turn, tasks for different keys at once", async () => {
  const lock = createKeyedLock();
  const log = [];
  const task = (name, ms) => async () => { log.push(`start ${name}`); await sleep(ms); log.push(`end ${name}`); };
  await Promise.all([
    lock("college-a", task("a1", 20)),
    lock("college-a", task("a2", 1)),
    lock("college-b", task("b1", 1)),
    lock(null, task("none", 1)),
  ]);
  assert.ok(log.indexOf("start a2") > log.indexOf("end a1"));
  assert.ok(log.indexOf("start b1") < log.indexOf("end a1"));
  assert.ok(log.indexOf("start none") < log.indexOf("end a1"));
});

const photo = (bytes) => ({ normalized: { buffer: Buffer.alloc(bytes), mimeType: "image/jpeg" }, quality: null });

test("the photo cache forgets entries after their time", () => {
  let now = 0;
  const cache = new PhotoCache({ maxBytes: 1000, ttlMs: 100, now: () => now });
  cache.set("a", photo(10));
  assert.ok(cache.get("a"));
  now = 101;
  assert.equal(cache.get("a"), null);
  assert.equal(cache.bytes, 0);
});

test("the photo cache stays within its memory budget, dropping the oldest", () => {
  const cache = new PhotoCache({ maxBytes: 100 });
  cache.set("a", photo(40));
  cache.set("b", photo(40));
  cache.set("c", photo(40));
  assert.equal(cache.get("a"), null);
  assert.ok(cache.get("b"));
  assert.ok(cache.get("c"));
  assert.equal(cache.bytes, 80);
  cache.set("huge", photo(500));
  assert.equal(cache.get("huge"), null, "a photo larger than the budget is not kept");
});

test("a photo checked by the preview is not downloaded or checked again by the import", async () => {
  const jpeg = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#8899aa" } }).jpeg().toBuffer();
  let downloads = 0;
  let checks = 0;
  const colleges = [{ _id: "c1", name: "Aurora Institute" }];
  const db = {
    collection(name) {
      if (name === "colleges") return { find: () => ({ toArray: async () => colleges }) };
      return { find: () => ({ toArray: async () => [] }) };
    },
  };
  const cache = new PhotoCache();
  const deps = {
    photoCache: cache,
    faceConfigured: true,
    fetcher: async () => { downloads += 1; return { buffer: jpeg, contentType: "image/jpeg" }; },
    checkQuality: async () => { checks += 1; return { ok: true, quality: { sharpness: 80 } }; },
    createInstructor: async (_db, fields) => ({ outcome: "created", instructor: { _id: `id-${fields.employee_id}`, ...fields } }),
    enrollPhoto: async () => ({ ok: true }),
  };
  const rows = Array.from({ length: 4 }, (_, index) => ({
    row: index + 2,
    name: `Person ${index}`,
    email: `p${index}@example.com`,
    gender: "Female",
    role: "Instructor",
    institute: "Aurora Institute",
    employee_id: `E${index}`,
    photo_url: `https://cdn.example.com/${index}.jpg`,
  }));

  const preview = await previewImportRows(db, rows, deps);
  assert.ok(preview.every((result) => result.ok));
  assert.equal(downloads, 4);
  assert.equal(checks, 4);

  const outcomes = await commitImportRows(db, rows, deps);
  assert.ok(outcomes.every((outcome) => outcome.ok && outcome.photo_enrolled));
  assert.equal(downloads, 4, "no second download");
  assert.equal(checks, 4, "no second face check");
  assert.deepEqual(outcomes.map((outcome) => outcome.row), [2, 3, 4, 5], "outcomes keep the rows' order");
  assert.equal(cache.bytes, 0, "used photos are released");
});

test("rows are written in parallel, except rows for the same institute", async () => {
  const colleges = [{ _id: "c1", name: "One" }, { _id: "c2", name: "Two" }];
  const db = {
    collection(name) {
      if (name === "colleges") return { find: () => ({ toArray: async () => colleges }) };
      return { find: () => ({ toArray: async () => [{ _id: "x", email: "unused@example.com", face_ids: ["f"] }] }) };
    },
  };
  let active = 0;
  let peak = 0;
  const perCollege = { c1: 0, c2: 0 };
  let perCollegePeak = 0;
  const deps = {
    photoCache: null,
    faceConfigured: true,
    updateInstructor: async (_db, _id, fields) => {
      active += 1;
      perCollege[fields.college_id] += 1;
      peak = Math.max(peak, active);
      perCollegePeak = Math.max(perCollegePeak, perCollege[fields.college_id]);
      await sleep(10);
      perCollege[fields.college_id] -= 1;
      active -= 1;
      return { outcome: "updated" };
    },
  };
  const found = [];
  const rows = Array.from({ length: 6 }, (_, index) => {
    const email = `u${index}@example.com`;
    found.push({ _id: `i${index}`, name: `U${index}`, email, employee_id: `E${index}`, face_ids: ["f"] });
    return { row: index + 2, name: `U${index}`, email, gender: "M", role: "Mentor", institute: index % 2 ? "Two" : "One", employee_id: `E${index}` };
  });
  db.collection = (name) => (name === "colleges"
    ? { find: () => ({ toArray: async () => colleges }) }
    : { find: () => ({ toArray: async () => found }) });
  const outcomes = await commitImportRows(db, rows, deps);
  assert.ok(outcomes.every((outcome) => outcome.ok), JSON.stringify(outcomes));
  assert.equal(peak, 2, "the two institutes are written at the same time");
  assert.equal(perCollegePeak, 1, "never two rows of one institute at once");
});
