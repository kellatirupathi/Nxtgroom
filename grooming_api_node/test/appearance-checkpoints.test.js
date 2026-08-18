import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkpointSet,
  improvementTips,
  IMPROVEMENT_TIPS,
  INFORMATIONAL_CODES,
  KURTI_ATTIRE_CHECKS,
  MEN_ATTIRE_CHECKS,
  SAREE_ATTIRE_CHECKS,
  SECTION_KEYS,
} from "../src/checkpoints.js";
import { buildSystemPrompt, PROMPT_VERSION } from "../src/prompts.js";
import { weeklyRotation } from "../src/services/instructorReports.js";
import { deriveVerdict, unknownGenderEvaluation } from "../src/services/visionEngine.js";

/**
 * The report is only comparable between two people, or between the same person
 * on two days, if every evaluation contains the same rows. These tests hold
 * the three checkpoint sets to their agreed shape, and hold the routing to the
 * rule that a report never mixes dress codes.
 */

const codesOf = (gender, attire) =>
  SECTION_KEYS.flatMap((key) => checkpointSet(gender, attire)[key].map((item) => item.code));

test("each variant returns its agreed number of checkpoints", () => {
  const shape = (gender, attire) =>
    SECTION_KEYS.map((key) => checkpointSet(gender, attire)[key].length);

  assert.deepEqual(shape("MALE", "FORMAL"), [1, 5, 8, 4, 2]);
  assert.deepEqual(shape("FEMALE", "SAREE"), [1, 5, 6, 5, 2]);
  assert.deepEqual(shape("FEMALE", "KURTI_WITH_DUPATTA"), [1, 5, 7, 5, 2]);

  assert.equal(codesOf("MALE", "FORMAL").length, 20);
  assert.equal(codesOf("FEMALE", "SAREE").length, 19);
  assert.equal(codesOf("FEMALE", "KURTI_WITH_DUPATTA").length, 20);
});

test("no checkpoint appears twice in a report", () => {
  for (const [gender, attire] of [["MALE", "FORMAL"], ["FEMALE", "SAREE"], ["FEMALE", "KURTI_WITH_DUPATTA"]]) {
    const codes = codesOf(gender, attire);
    assert.equal(new Set(codes).size, codes.length, `${gender}/${attire} repeats a checkpoint`);
  }
});

test("a report never mixes two dress codes", () => {
  const male = new Set(codesOf("MALE", "FORMAL"));
  const saree = new Set(codesOf("FEMALE", "SAREE"));
  const kurti = new Set(codesOf("FEMALE", "KURTI_WITH_DUPATTA"));

  // Men's shirt and beard rules reaching a woman's report, or saree rules
  // reaching a man's, is the exact failure the fixed sets exist to prevent.
  for (const code of MEN_ATTIRE_CHECKS.map((item) => item.code)) {
    assert.equal(saree.has(code), false, `${code} leaked into the saree report`);
    assert.equal(kurti.has(code), false, `${code} leaked into the kurti report`);
  }
  for (const code of SAREE_ATTIRE_CHECKS.map((item) => item.code)) {
    assert.equal(male.has(code), false, `${code} leaked into the male report`);
    assert.equal(kurti.has(code), false, `${code} leaked into the kurti report`);
  }
  for (const code of KURTI_ATTIRE_CHECKS.map((item) => item.code)) {
    assert.equal(male.has(code), false, `${code} leaked into the male report`);
    assert.equal(saree.has(code), false, `${code} leaked into the saree report`);
  }
});

test("an unknown gender yields no checkpoint set at all", () => {
  // Not an empty set and not a merged one: sending both dress codes is what
  // caused men to be measured against saree standards.
  for (const gender of [null, undefined, "", "OTHER", "unknown"]) {
    assert.equal(checkpointSet(gender, "SAREE"), null);
  }
  assert.throws(() => buildSystemPrompt(null, "SAREE"));
});

test("the prompt asks for exactly the checkpoints the schema will accept", () => {
  for (const [gender, attire] of [["MALE", "FORMAL"], ["FEMALE", "SAREE"], ["FEMALE", "KURTI_WITH_DUPATTA"]]) {
    const prompt = buildSystemPrompt(gender, attire);
    for (const code of codesOf(gender, attire)) {
      assert.match(prompt, new RegExp(`\\b${code}\\b`), `${code} is missing from the ${gender} prompt`);
    }
    // A prompt that also described the other dress code would invite the model
    // to volunteer rows the schema then rejects.
    const foreign = gender === "MALE"
      ? SAREE_ATTIRE_CHECKS.concat(KURTI_ATTIRE_CHECKS)
      : MEN_ATTIRE_CHECKS;
    for (const item of foreign) {
      assert.doesNotMatch(prompt, new RegExp(`\\b${item.code}\\b`), `${item.code} should not be offered here`);
    }
  }
});

test("the prompt forbids judging what a photograph cannot show", () => {
  const prompt = buildSystemPrompt("FEMALE", "SAREE");
  for (const excluded of ["odour", "breath", "bathing", "hygiene", "fragrance", "confidence"]) {
    assert.match(prompt, new RegExp(excluded, "i"), `${excluded} should be named as out of scope`);
  }
  // Cultural wear must be stated, not left for the model to infer.
  assert.match(prompt, /mangalsutra/i);
  assert.match(prompt, /never a violation in itself/i);
});

test("the prompt version records that the checkpoints changed", () => {
  assert.match(PROMPT_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.notEqual(PROMPT_VERSION, "2026-08-17.1");
});

test("every scored checkpoint can tell a failing instructor what to change", () => {
  for (const [gender, attire] of [["MALE", "FORMAL"], ["FEMALE", "SAREE"], ["FEMALE", "KURTI_WITH_DUPATTA"]]) {
    for (const code of codesOf(gender, attire)) {
      // An informational row has no rule to break, so it has nothing to advise.
      if (INFORMATIONAL_CODES.has(code)) continue;
      assert.ok(IMPROVEMENT_TIPS[code], `${code} has no improvement tip`);
    }
  }
});

test("an optional item cannot make anybody non-compliant", () => {
  // A watch is recorded, not required. Excluded from the verdict outright
  // rather than trusted to come back as PASS, so a model that returns FAIL for
  // one cannot mark somebody non-compliant for wearing it.
  const rows = {
    general_idcard_check: [{ code: "ID_PRESENT", status: "PASS" }],
    accessories_check: [{ code: "M_WATCH", status: "FAIL" }],
  };
  assert.equal(deriveVerdict(rows, { imageQuality: "ADEQUATE" }).overall_status, "COMPLIANT");
  assert.deepEqual(improvementTips(rows), []);
});

test("checks the stakeholders asked to drop are gone", () => {
  const everything = new Set([
    ...codesOf("MALE", "FORMAL"),
    ...codesOf("FEMALE", "SAREE"),
    ...codesOf("FEMALE", "KURTI_WITH_DUPATTA"),
  ]);
  // Eyewear, hair colour, heel height, mangalsutra and nose pin were removed;
  // the ID card collapsed from six rows to one.
  for (const code of [
    "M_EYEWEAR", "W_EYEWEAR", "M_HAIR_COLOR", "W_HAIR_COLOR", "W_HEEL_HEIGHT",
    "W_CHAIN", "W_NOSE_PIN", "ID_VISIBILITY", "ID_CHEST_POSITION",
    "ID_OFFICIAL_LANYARD", "ID_READABILITY", "ID_CONDITION",
  ]) {
    assert.equal(everything.has(code), false, `${code} should no longer be asked for`);
  }
  // Hair position is now its own row rather than folded into neatness, because
  // hair across the face is the failure the reports kept missing.
  assert.ok(everything.has("M_HAIR_POSITION"));
  assert.ok(everything.has("W_HAIR_POSITION"));
});

test("improvement tips come only from failures", () => {
  const sections = {
    general_idcard_check: [{ code: "ID_PRESENT", status: "PASS" }],
    grooming_check: [{ code: "M_FACIAL_HAIR", status: "N/A" }],
    attire_check: [
      { code: "M_SHIRT_TYPE", status: "FAIL" },
      { code: "M_TROUSERS_TYPE", status: "FAIL" },
    ],
    accessories_check: [],
    footwear_check: [{ code: "M_FOOTWEAR_TYPE", status: "FAIL" }],
  };
  assert.deepEqual(improvementTips(sections), [
    "Wear a formal full-sleeve collared shirt.",
    "Replace jeans with formal trousers.",
    "Wear clean formal shoes instead of casual footwear.",
  ]);

  // A passing report has nothing to advise, and an unassessable checkpoint is
  // not something the instructor did.
  assert.deepEqual(improvementTips({
    general_idcard_check: [{ code: "ID_PRESENT", status: "PASS" }],
    grooming_check: [{ code: "M_EYEWEAR", status: "N/A" }],
  }), []);
});

test("the weekly rotation is judged only when the week is over", () => {
  const week = { gender: "FEMALE", sareeDays: 1, kurtiDays: 1, unknownDays: 0 };
  assert.equal(weeklyRotation({ ...week, weekComplete: false }).status, "IN_PROGRESS");
  assert.equal(weeklyRotation({ ...week, weekComplete: true }).status, "FAIL");
  assert.equal(
    weeklyRotation({ gender: "FEMALE", sareeDays: 3, kurtiDays: 3, unknownDays: 0, weekComplete: true }).status,
    "PASS"
  );
  // A day nobody could classify leaves the week unjudgeable, not failed.
  assert.equal(
    weeklyRotation({ gender: "FEMALE", sareeDays: 3, kurtiDays: 2, unknownDays: 1, weekComplete: true }).status,
    "INSUFFICIENT_DATA"
  );
});

test("the rotation does not apply to men", () => {
  // Formal wear every day is correct for a man, so scoring him against a
  // saree/kurti split would manufacture a violation.
  for (const gender of ["MALE", null, "", undefined]) {
    assert.equal(
      weeklyRotation({ gender, sareeDays: 0, kurtiDays: 0, unknownDays: 0, weekComplete: true }),
      null
    );
  }
});

test("a failing checkpoint makes the report non-compliant", () => {
  const verdict = deriveVerdict({
    general_idcard_check: [{ status: "PASS" }],
    attire_check: [{ status: "FAIL" }],
    footwear_check: [{ status: "PASS" }],
  }, { imageQuality: "ADEQUATE" });
  assert.equal(verdict.overall_status, "NON_COMPLIANT");
});

test("an unassessable checkpoint is not a violation", () => {
  // N/A means the camera could not show it, which is never something the
  // instructor did wrong. Treating it as failure would punish bad framing.
  const verdict = deriveVerdict({
    general_idcard_check: [{ status: "PASS" }],
    grooming_check: [{ status: "N/A" }, { status: "N/A" }],
    attire_check: [{ status: "PASS" }],
    footwear_check: [{ status: "PASS" }],
  }, { imageQuality: "ADEQUATE" });
  assert.equal(verdict.overall_status, "COMPLIANT");
});

test("a critical area that could not be seen does not fail the report", () => {
  for (const section of ["general_idcard_check", "attire_check", "footwear_check"]) {
    const rows = {
      general_idcard_check: [{ status: "PASS" }],
      attire_check: [{ status: "PASS" }],
      footwear_check: [{ status: "PASS" }],
    };
    rows[section] = [{ status: "N/A" }];
    const verdict = deriveVerdict(rows, { imageQuality: "ADEQUATE" });
    assert.equal(verdict.overall_status, "COMPLIANT", `${section} must not fail the report`);
  }
});

test("a photo showing nothing assessable asks for a retake, not a verdict", () => {
  const verdict = deriveVerdict({
    general_idcard_check: [{ status: "N/A" }],
    attire_check: [{ status: "N/A" }],
    footwear_check: [{ status: "N/A" }],
  }, { imageQuality: "ADEQUATE" });
  assert.equal(verdict.overall_status, "COMPLIANT");
  assert.equal(verdict.image_quality, "RETAKE_RECOMMENDED");
});

test("a missing gender produces no compliance claim", () => {
  const evaluation = unknownGenderEvaluation();
  // Not NON_COMPLIANT: the instructor did nothing wrong, the record is
  // incomplete. The reason says so rather than a verdict implying otherwise.
  assert.equal(evaluation.overall_status, "COMPLIANT");
  assert.equal(evaluation.unassessed_reason, "GENDER_NOT_CONFIGURED");
  for (const key of SECTION_KEYS) {
    assert.deepEqual(evaluation[key], [], `${key} must stay empty without a dress code`);
  }
  assert.match(evaluation.ai_summary, /gender/i);
});

test("each half of a record has its own evaluation", async () => {
  const { evaluationFilter } = await import("../src/services/evaluationWorker.js");
  // Every evaluation stored before check-out analysis existed has no kind
  // field, and all of them are check-ins. Matching "checkin" alone would have
  // hidden the entire history behind an empty report.
  assert.deepEqual(evaluationFilter("a1"), { attendance_id: "a1", kind: { $ne: "checkout" } });
  assert.deepEqual(evaluationFilter("a1", "checkin"), { attendance_id: "a1", kind: { $ne: "checkout" } });
  assert.deepEqual(evaluationFilter("a1", "checkout"), { attendance_id: "a1", kind: "checkout" });

  // The two filters must not both match one document, or a check-out would
  // overwrite the morning's report.
  const checkin = { attendance_id: "a1" };
  const checkout = { attendance_id: "a1", kind: "checkout" };
  const matches = (filter, doc) => Object.entries(filter).every(([key, value]) => (
    value && typeof value === "object" && "$ne" in value ? doc[key] !== value.$ne : doc[key] === value
  ));
  assert.equal(matches(evaluationFilter("a1"), checkin), true);
  assert.equal(matches(evaluationFilter("a1"), checkout), false);
  assert.equal(matches(evaluationFilter("a1", "checkout"), checkout), true);
  assert.equal(matches(evaluationFilter("a1", "checkout"), checkin), false);
});
