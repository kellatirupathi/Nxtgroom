import assert from "node:assert/strict";
import { test } from "node:test";
import { MEN_ACCESSORIES_CHECKS, MEN_ATTIRE_CHECKS, MEN_GROOMING_CHECKS } from "../src/checkpoints.js";
import { buildSystemPrompt } from "../src/prompts.js";
import { resolveMaleAttireVisibility } from "../src/services/visionEngine.js";

const row = (code, status, observation = "Not visible.", reason = "Cannot assess.") => ({
  code,
  status,
  observation,
  reason,
});

const rowsWith = ({ fit = "PASS", tuck = "PASS", belt = "PASS", rings, chain } = {}) => ({
  attire_check: [
    row("M_SHIRT_FIT", fit),
    row("M_SHIRT_COLLAR_TUCK", tuck),
    row("M_BELT", belt),
  ],
  accessories_check: [
    row("M_RINGS", rings?.status || "PASS", rings?.observation, rings?.reason),
    row("M_CHAIN", chain?.status || "PASS", chain?.observation, chain?.reason),
  ],
});

const statusOf = (rows, section, code) => rows[section].find((item) => item.code === code).status;

test("an unshown required shirt tuck and belt are failures, not N/A", () => {
  const rows = rowsWith({ tuck: "N/A", belt: "N/A" });
  resolveMaleAttireVisibility(rows, { upper_body: "PARTIAL", lower_body: "PARTIAL" });

  assert.equal(statusOf(rows, "attire_check", "M_SHIRT_COLLAR_TUCK"), "FAIL");
  assert.equal(statusOf(rows, "attire_check", "M_BELT"), "FAIL");
  assert.match(rows.attire_check.find((item) => item.code === "M_SHIRT_COLLAR_TUCK").reason, /does not show.*shirt tuck/i);
  assert.match(rows.attire_check.find((item) => item.code === "M_BELT").reason, /does not show.*belt/i);
});

test("existing tuck and belt judgements are never overwritten", () => {
  for (const status of ["PASS", "FAIL"]) {
    const rows = rowsWith({ tuck: status, belt: status });
    resolveMaleAttireVisibility(rows, {});
    assert.equal(statusOf(rows, "attire_check", "M_SHIRT_COLLAR_TUCK"), status);
    assert.equal(statusOf(rows, "attire_check", "M_BELT"), status);
  }
});

test("a tuck-only finding cannot fail the separate shirt-fit checkpoint", () => {
  const rows = rowsWith({ fit: "FAIL" });
  const fit = rows.attire_check.find((item) => item.code === "M_SHIRT_FIT");
  fit.observation = "The shirt is not fully tucked in at the waist.";
  fit.reason = "The shirt appears untucked near the belt.";

  resolveMaleAttireVisibility(rows, {});

  assert.equal(fit.status, "PASS");
  assert.match(fit.reason, /only in the Shirt Collar \/ Tuck checkpoint/i);
});

test("a real shirt-fit violation remains a failure", () => {
  const rows = rowsWith({ fit: "FAIL" });
  const fit = rows.attire_check.find((item) => item.code === "M_SHIRT_FIT");
  fit.observation = "The shirt is pulling tightly at the buttons.";
  fit.reason = "Severe tightness is visible across the torso.";

  resolveMaleAttireVisibility(rows, {});

  assert.equal(fit.status, "FAIL");
});

test("clearly absent rings and chain become PASS when their regions are visible", () => {
  const rows = rowsWith({
    rings: { status: "N/A", observation: "Both hands are visible and no rings are noted.", reason: "No rings are present." },
    chain: { status: "N/A", observation: "No chain or necklace is visible above the collar.", reason: "No chain is present." },
  });
  resolveMaleAttireVisibility(rows, { hands: "VISIBLE", upper_body: "VISIBLE" });

  assert.equal(statusOf(rows, "accessories_check", "M_RINGS"), "PASS");
  assert.equal(statusOf(rows, "accessories_check", "M_CHAIN"), "PASS");
});

test("rings and chain stay N/A when the relevant area cannot be judged", () => {
  for (const region of ["PARTIAL", "NOT_VISIBLE", undefined]) {
    const rows = rowsWith({
      rings: { status: "N/A", observation: "No rings are visible." },
      chain: { status: "N/A", observation: "No chain or necklace is visible." },
    });
    resolveMaleAttireVisibility(rows, { hands: region, upper_body: region });
    assert.equal(statusOf(rows, "accessories_check", "M_RINGS"), "N/A");
    assert.equal(statusOf(rows, "accessories_check", "M_CHAIN"), "N/A");
  }
});

test("an explicit visibility limitation stays N/A even when the broad region is visible", () => {
  const rows = rowsWith({
    rings: { status: "N/A", observation: "No rings are visible because the fingers are blurred." },
    chain: { status: "N/A", observation: "The chain is not visible because the collar is obscured." },
  });
  resolveMaleAttireVisibility(rows, { hands: "VISIBLE", upper_body: "VISIBLE" });
  assert.equal(statusOf(rows, "accessories_check", "M_RINGS"), "N/A");
  assert.equal(statusOf(rows, "accessories_check", "M_CHAIN"), "N/A");
});

test("accessory PASS and FAIL decisions are left unchanged", () => {
  for (const status of ["PASS", "FAIL"]) {
    const rows = rowsWith({
      rings: { status, observation: "Visible rings assessed." },
      chain: { status, observation: "Visible chain assessed." },
    });
    resolveMaleAttireVisibility(rows, { hands: "VISIBLE", upper_body: "VISIBLE" });
    assert.equal(statusOf(rows, "accessories_check", "M_RINGS"), status);
    assert.equal(statusOf(rows, "accessories_check", "M_CHAIN"), status);
  }
});

test("the written standards state the required visibility outcomes", () => {
  const fit = MEN_ATTIRE_CHECKS.find((item) => item.code === "M_SHIRT_FIT").rule;
  const tuck = MEN_ATTIRE_CHECKS.find((item) => item.code === "M_SHIRT_COLLAR_TUCK").rule;
  const belt = MEN_ATTIRE_CHECKS.find((item) => item.code === "M_BELT").rule;
  const rings = MEN_ACCESSORIES_CHECKS.find((item) => item.code === "M_RINGS").rule;
  const chain = MEN_ACCESSORIES_CHECKS.find((item) => item.code === "M_CHAIN").rule;
  const facialHair = MEN_GROOMING_CHECKS.find((item) => item.code === "M_FACIAL_HAIR").rule;
  const moustache = MEN_GROOMING_CHECKS.find((item) => item.code === "M_MOUSTACHE").rule;

  assert.match(fit, /tucked are not part of this checkpoint/i);
  assert.match(tuck, /FAIL only when[\s\S]*does not show the waist\/tuck area/i);
  assert.match(belt, /does not show the waist\/belt area.*FAIL|FAIL when.*does not show the waist\/belt area/i);
  assert.match(rings, /absence of rings.*PASS, not N\/A/i);
  assert.match(chain, /absence of jewellery.*PASS, not N\/A/i);
  assert.match(facialHair, /when the face, jaw and chin are discernible, make the assessment/i);
  assert.match(moustache, /when the mouth and upper lip are discernible, make the assessment/i);
  assert.match(buildSystemPrompt("MALE", "FORMAL"), /clear hands with no rings[\s\S]*PASS, not N\/A/i);
  assert.match(buildSystemPrompt("MALE", "FORMAL"), /shirt must never fail Shirt Fit because it is or[\s\S]*appears untucked/i);
});
