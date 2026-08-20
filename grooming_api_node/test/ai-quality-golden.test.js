import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const cases = JSON.parse(await readFile(new URL("./fixtures/ai-quality-golden.json", import.meta.url), "utf8"));

test("AI quality manifest covers the critical visual risk categories", () => {
  assert.ok(cases.some((item) => item.gender === "MALE"));
  assert.ok(cases.some((item) => item.gender === "FEMALE"));
  for (const attire of ["FORMAL", "SAREE", "KURTI_WITH_DUPATTA"]) {
    assert.ok(cases.some((item) => item.attire === attire), `missing ${attire}`);
  }
  assert.ok(cases.some((item) => item.lighting === "poor"));
  assert.ok(cases.some((item) => item.framing === "upper_body"));
  assert.ok(cases.some((item) => item.people > 1));
  assert.ok(cases.some((item) => item.mirror));
  assert.ok(cases.some((item) => item.occlusion !== "none"));
  assert.ok(cases.some((item) => item.expected === "UNASSESSED"));
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
});
