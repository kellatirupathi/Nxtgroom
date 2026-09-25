import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointSet, improvementTips, SECTION_KEYS } from "../src/checkpoints.js";
import { buildSystemPrompt, PROMPT_VERSION } from "../src/prompts.js";

/**
 * The appearance rules changed on 25 Sep 2026, at NxtWave's request:
 *
 *  - Men: hair must be set back or up with the whole forehead clear. Any hair
 *    resting on the forehead fails, however neat; messy hair fails.
 *  - Women: a sleeve must reach at least halfway from the shoulder to the
 *    elbow, on a kurti, a saree blouse and a western top alike. Shorter fails;
 *    half sleeves at or below that point now PASS on a kurti, where they used
 *    to fail.
 *  - Women: palazzo pants or straight trousers only. Leggings, jeggings and any
 *    skin-tight bottom fail; so do churidar and gathered patiala/dhoti salwar.
 *
 * Each is pinned twice - in the checkpoint the report is scored against, and in
 * the prompt the model actually receives - because a rule that changed in one
 * place and not the other is a model told two different things.
 */

const find = (gender, attire, code) => {
  const sections = checkpointSet(gender, attire);
  for (const key of SECTION_KEYS) {
    const row = sections[key].find((item) => item.code === code);
    if (row) return row;
  }
  throw new Error(`${code} is not in the ${gender} ${attire} set`);
};

test("men: any hair on the forehead fails, and the forehead must be clear", () => {
  const position = find("MALE", "FORMAL", "M_HAIR_POSITION").rule;
  assert.match(position, /whole forehead is clear/i);
  assert.match(position, /FAIL when any fringe, strands or locks rest on, hang over or cover any part of the forehead/i);
  assert.match(position, /even when that hair is otherwise tidy or deliberately styled forward/i);
  const neatness = find("MALE", "FORMAL", "M_HAIR_NEATNESS").rule;
  assert.match(neatness, /FAIL messy, uncombed, dishevelled/i);
  assert.match(neatness, /on top of the head/i);

  const prompt = buildSystemPrompt("MALE", "FORMAL");
  assert.match(prompt, /### HAIR ON THE FOREHEAD/);
  assert.match(prompt, /Any fringe or strands resting on or hanging over the forehead fail Hair Position/);
});

test("women: sleeves must reach halfway to the elbow on every outfit", () => {
  for (const [attire, code] of [
    ["KURTI_WITH_DUPATTA", "W_KURTI_NECKLINE_SLEEVES"],
    ["SAREE", "W_SAREE_BLOUSE"],
    ["FORMAL", "W_FORMAL_TOP"],
  ]) {
    const rule = find("FEMALE", attire, code).rule;
    assert.match(rule, /at least halfway from the shoulder to the elbow/i, `${code} lacks the halfway rule`);
    assert.match(rule, /cap sleeve/i, `${code} must fail cap sleeves`);
  }
  // Sleeveless saree blouses still fail outright.
  assert.match(find("FEMALE", "SAREE", "W_SAREE_BLOUSE").rule, /SLEEVELESS BLOUSE IS NOT PERMITTED/);
});

test("women: a half sleeve on a kurti now passes, where it used to fail", () => {
  const rule = find("FEMALE", "KURTI_WITH_DUPATTA", "W_KURTI_NECKLINE_SLEEVES").rule;
  assert.match(rule, /a half sleeve ending at the middle of the upper arm or lower/i);
  assert.doesNotMatch(rule, /half sleeves, cap sleeves and sleeveless are all a FAIL/i);
  assert.doesNotMatch(rule, /requires full or three-quarter length/i);

  // And the prompt no longer contradicts it.
  const prompt = buildSystemPrompt("FEMALE", "KURTI_WITH_DUPATTA");
  assert.doesNotMatch(prompt, /short, half, cap or sleeveless sleeves is a FAIL/);
  assert.match(prompt, /Sleeves must reach at least halfway from the shoulder to the elbow/);
});

test("women: palazzo passes; leggings, jeggings, churidar and gathered salwar fail", () => {
  const bottom = find("FEMALE", "KURTI_WITH_DUPATTA", "W_BOTTOM_WEAR").rule;
  assert.match(bottom, /^Palazzo pants or straight formal trousers/);
  assert.match(bottom, /FAIL leggings, jeggings and any skin-tight bottom/);
  assert.match(bottom, /FAIL churidar and patiala, dhoti or heavily gathered salwar/);
  // Churidar is no longer listed among what passes.
  assert.doesNotMatch(bottom, /Palazzo, churidar or straight/);

  const formal = find("FEMALE", "FORMAL", "W_FORMAL_BOTTOM_TYPE").rule;
  assert.match(formal, /leggings, jeggings or any skin-tight trousers/);

  const prompt = buildSystemPrompt("FEMALE", "KURTI_WITH_DUPATTA");
  assert.match(prompt, /Leggings, jeggings and other skin-tight bottoms fail, as do churidar/);
});

test("the advice in the report matches the new rules", () => {
  const failing = (gender, attire, codes) => {
    const report = {};
    const sections = checkpointSet(gender, attire);
    for (const key of SECTION_KEYS) {
      report[key] = sections[key].map((item) => ({
        code: item.code,
        status: codes.includes(item.code) ? "FAIL" : "PASS",
      }));
    }
    return improvementTips({ ...report, overall_status: "NON_COMPLIANT" }).join(" ");
  };
  assert.match(failing("MALE", "FORMAL", ["M_HAIR_POSITION"]), /forehead is fully clear/);
  const kurti = failing("FEMALE", "KURTI_WITH_DUPATTA", ["W_KURTI_NECKLINE_SLEEVES", "W_BOTTOM_WEAR"]);
  assert.match(kurti, /at least halfway to the elbow/);
  assert.match(kurti, /palazzo pants or straight formal trousers/i);
  assert.match(kurti, /Leggings, churidar and gathered salwar are not permitted/);
  assert.doesNotMatch(kurti, /three-quarter/);
});

test("the prompt version moved, so stored reports say which rules judged them", () => {
  assert.equal(PROMPT_VERSION, "2026-09-25.1");
});
