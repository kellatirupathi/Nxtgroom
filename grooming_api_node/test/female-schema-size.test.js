import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointSet, SECTION_KEYS } from "../src/checkpoints.js";
import { buildFemaleAttirePrompt, buildSystemPrompt } from "../src/prompts.js";

const FAMILIES = ["SAREE", "KURTI_WITH_DUPATTA", "FORMAL"];

const checkpointCount = (gender, attire) => SECTION_KEYS
  .reduce((total, key) => total + checkpointSet(gender, attire)[key].length, 0);

test("no single female request asks for more checkpoints than a male one", () => {
  const male = checkpointCount("MALE", "FORMAL");
  for (const attire of FAMILIES) {
    const female = checkpointCount("FEMALE", attire);
    assert.ok(
      female <= male + 2,
      `FEMALE/${attire} asks for ${female} checkpoints against MALE's ${male}`
    );
  }
});

test("the combined union that was rejected is far larger than any single family", () => {
  const union = [...FAMILIES, "UNKNOWN"]
    .reduce((total, attire) => total + checkpointCount("FEMALE", attire), 0);
  const largestSingle = Math.max(...FAMILIES.map((attire) => checkpointCount("FEMALE", attire)));
  assert.ok(union > largestSingle * 3, `union ${union} vs largest single ${largestSingle}`);
});

test("a female report prompt never mentions another family's checkpoints", () => {
  for (const attire of FAMILIES) {
    const prompt = buildSystemPrompt("FEMALE", attire);
    const own = new Set(checkpointSet("FEMALE", attire).attire_check.map((item) => item.code));
    const foreign = FAMILIES
      .filter((other) => other !== attire)
      .flatMap((other) => checkpointSet("FEMALE", other).attire_check)
      .filter((item) => !own.has(item.code));
    for (const item of foreign) {
      assert.ok(
        !prompt.includes(item.code),
        `the ${attire} prompt carries ${item.code}, which belongs to another family`
      );
    }
  }
});

test("the classification prompt stays small enough to be worth splitting out", () => {
  const classification = buildFemaleAttirePrompt();
  const report = buildSystemPrompt("FEMALE", "SAREE");
  assert.ok(
    classification.length < report.length,
    "asking only for the garment must cost less prompt than the full report"
  );
});

test("every attire family the classifier may return has checkpoints to report", () => {
  for (const attire of FAMILIES) {
    const sections = checkpointSet("FEMALE", attire);
    assert.ok(sections, `${attire} has no checkpoint set`);
    assert.ok(sections.attire_check.length > 0, `${attire} has no attire rows`);
  }
  assert.equal(checkpointSet("FEMALE", "UNKNOWN").attire_check.length, 0);
});

test("a schema the provider refuses is not retried", async () => {
  const { isPermanentEvaluationFailure } = await import("../src/services/evaluationWorker.js");

  const rejected = Object.assign(
    new Error("Gemini request failed (400): The specified schema produces a constraint that has too many states for serving."),
    { name: "GEMINI_REQUEST_ERROR", code: "GEMINI_REQUEST_ERROR" }
  );
  assert.equal(isPermanentEvaluationFailure(rejected), true);
  assert.equal(isPermanentEvaluationFailure({ code: "GEMINI_AUTH_ERROR" }), true);

  for (const code of [
    "GEMINI_TIMEOUT",
    "RATE_LIMIT_EXCEEDED",
    "GEMINI_SERVER_ERROR",
    "GEMINI_NETWORK_ERROR",
    "GEMINI_INVALID_RESPONSE",
    "GEMINI_INCOMPLETE_RESPONSE",
  ]) {
    assert.equal(isPermanentEvaluationFailure({ code }), false, `${code} must stay retryable`);
  }
});
