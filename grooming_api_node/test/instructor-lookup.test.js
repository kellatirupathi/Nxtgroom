import assert from "node:assert/strict";
import { test } from "node:test";
import { idMatch } from "../src/middleware/auth.js";

// Ids are strings: records copied from the old database keep their
// 24-character ids, and records added by hand have UUIDs.
const COPIED_ID = "6a82eb647377e77789a4bede";
const UUID = "ce4293b8-0eb1-43fa-9181-8ac06081078b";

test("idMatch matches an id exactly, whatever its shape", () => {
  assert.deepEqual(idMatch(COPIED_ID), { $in: [COPIED_ID] });
  assert.deepEqual(idMatch(UUID), { $in: [UUID] });
});

test("idMatch turns a non-string id into its string form", () => {
  assert.deepEqual(idMatch(42), { $in: ["42"] });
});

test("no instructor lookup outside the roster code compares a raw id", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = [
    "src/services/evaluationWorker.js",
    "src/routes/reportRoutes.js",
  ];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const lookups = [...source.matchAll(
      /collection\("instructors"\)[\s\S]{0,80}?findOne\(\{\s*_id:\s*([A-Za-z_$][\w$]*)/g
    )];
    assert.ok(lookups.length > 0, `${file} no longer looks up an instructor; update this test`);
    for (const [, expression] of lookups) {
      assert.equal(expression, "idMatch", `${file} looks up an instructor with a raw ${expression}`);
    }
  }
});
