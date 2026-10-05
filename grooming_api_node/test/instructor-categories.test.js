import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  addInstructorCategory,
  deleteInstructorCategory,
  listInstructorCategories,
  renameInstructorCategory,
  validateCategoryName,
} from "../src/services/instructorCategories.js";
import { instructorSchema } from "../src/validation.js";

function matches(value, filter) {
  if (filter && typeof filter === "object" && "$regex" in filter) {
    return typeof value === "string" && new RegExp(filter.$regex, filter.$options).test(value);
  }
  return value === filter;
}

function categoriesDb(instructors, stored = null) {
  const settings = new Map(stored ? [["config_settings", { _id: "config_settings", ...stored }]] : []);
  let saves = 0;
  return {
    settings,
    instructors,
    saves: () => saves,
    collection(name) {
      if (name === "app_settings") return {
        findOne: async ({ _id }) => settings.get(_id) || null,
        updateOne: async ({ _id }, update) => {
          saves += 1;
          settings.set(_id, { ...(settings.get(_id) || update.$setOnInsert || {}), ...update.$set });
          return { matchedCount: 1 };
        },
      };
      if (name === "instructors") return {
        aggregate: () => ({
          toArray: async () => {
            const counts = new Map();
            for (const row of instructors) {
              if (row.deleted_at || typeof row.instructor_category !== "string" || !row.instructor_category) continue;
              counts.set(row.instructor_category, (counts.get(row.instructor_category) || 0) + 1);
            }
            return [...counts].map(([_id, count]) => ({ _id, count }));
          },
        }),
        updateMany: async (filter, update) => {
          let modifiedCount = 0;
          for (const row of instructors) {
            if (matches(row.instructor_category, filter.instructor_category)) {
              Object.assign(row, update.$set);
              modifiedCount += 1;
            }
          }
          return { modifiedCount };
        },
      };
      throw new Error(`unexpected ${name}`);
    },
  };
}

const people = () => [
  { _id: "1", instructor_category: "TECH" },
  { _id: "2", instructor_category: "TECH" },
  { _id: "3", instructor_category: "ENGLISH" },
  { _id: "4", instructor_category: "MATH" },
  { _id: "5", instructor_category: "APTITUDE" },
  { _id: "6", instructor_category: "" },
  { _id: "7" },
  { _id: "8", instructor_category: "SCIENCE", deleted_at: new Date() },
];

test("the first read lists the categories already on instructors, with how many use each", async () => {
  const db = categoriesDb(people());
  assert.deepEqual(await listInstructorCategories(db), [
    { name: "APTITUDE", count: 1 },
    { name: "ENGLISH", count: 1 },
    { name: "MATH", count: 1 },
    { name: "TECH", count: 2 },
  ]);
  assert.deepEqual(db.settings.get("config_settings").instructor_categories, ["APTITUDE", "ENGLISH", "MATH", "TECH"]);
  await listInstructorCategories(db);
  assert.equal(db.saves(), 1, "saved once, not on every read");
});

test("a category is added once, whatever its case", async () => {
  const db = categoriesDb(people());
  const added = await addInstructorCategory(db, "  Soft   Skills ", "admin@x");
  assert.equal(added.outcome, "added");
  assert.deepEqual(added.categories.map((row) => row.name), ["APTITUDE", "ENGLISH", "MATH", "Soft Skills", "TECH"]);
  assert.equal((await addInstructorCategory(db, "soft skills")).outcome, "duplicate");
  assert.equal((await addInstructorCategory(db, "tech")).outcome, "duplicate");
  assert.equal((await addInstructorCategory(db, "   ")).outcome, "invalid");
  assert.equal((await addInstructorCategory(db, "x".repeat(61))).outcome, "invalid");
  assert.equal(db.settings.get("config_settings").updated_by, "admin@x");
});

test("renaming a category moves its instructors to the new name", async () => {
  const instructors = people();
  const db = categoriesDb(instructors);
  const renamed = await renameInstructorCategory(db, "TECH", "Technology");
  assert.equal(renamed.outcome, "renamed");
  assert.equal(renamed.moved, 2);
  assert.deepEqual(renamed.categories.find((row) => row.name === "Technology"), { name: "Technology", count: 2 });
  assert.ok(!renamed.categories.some((row) => row.name === "TECH"));
  assert.deepEqual(instructors.filter((row) => row.instructor_category === "Technology").map((row) => row._id), ["1", "2"]);
  assert.equal((await renameInstructorCategory(db, "MATH", "english")).outcome, "duplicate");
  assert.equal((await renameInstructorCategory(db, "NOPE", "Other")).outcome, "not_found");
  assert.equal((await renameInstructorCategory(db, "MATH", "")).outcome, "invalid");
  assert.equal((await renameInstructorCategory(db, "MATH", "Math")).outcome, "renamed", "only the case changes");
});

test("a category in use cannot be deleted; an unused one can", async () => {
  const db = categoriesDb(people());
  assert.deepEqual(await deleteInstructorCategory(db, "TECH"), { outcome: "in_use", count: 2 });
  await addInstructorCategory(db, "Spare");
  const deleted = await deleteInstructorCategory(db, "spare");
  assert.equal(deleted.outcome, "deleted");
  assert.ok(!deleted.categories.some((row) => row.name === "Spare"));
  assert.equal((await deleteInstructorCategory(db, "Spare")).outcome, "not_found");
});

test("category names are trimmed and limited to 60 characters", () => {
  assert.deepEqual(validateCategoryName(" Data  Science "), { valid: true, name: "Data Science" });
  assert.equal(validateCategoryName("").valid, false);
  assert.equal(validateCategoryName(42).valid, false);
});

test("an instructor's category is optional, and blank clears it", () => {
  const base = { name: "Ravi Kumar", role: "INSTRUCTOR", gender: "MALE", college_id: "c1", email: "ravi@x.com" };
  assert.equal(instructorSchema.parse({ ...base, instructor_category: " TECH " }).instructor_category, "TECH");
  assert.equal(instructorSchema.parse({ ...base, instructor_category: "" }).instructor_category, null);
  assert.ok(!("instructor_category" in instructorSchema.parse(base)), "left alone when not sent");
  assert.equal(instructorSchema.safeParse({ ...base, instructor_category: "x".repeat(61) }).success, false);
});

test("Settings serves the category list and its add, rename and delete", async () => {
  const admin = await readFile(new URL("../src/routes/adminRoutes.js", import.meta.url), "utf8");
  assert.match(admin, /adminRouter\.get\(\s*"\/settings\/config\/categories",\s*requireSuperAdmin,/);
  assert.match(admin, /adminRouter\.post\(\s*"\/settings\/config\/categories",\s*requireSuperAdmin,/);
  assert.match(admin, /adminRouter\.put\(\s*"\/settings\/config\/categories\/:name",\s*requireSuperAdmin,/);
  assert.match(admin, /adminRouter\.delete\(\s*"\/settings\/config\/categories\/:name",\s*requireSuperAdmin,/);
});
