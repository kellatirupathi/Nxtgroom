import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointSet, improvementTips, SECTION_KEYS } from "../src/checkpoints.js";
import { buildSystemPrompt, PROMPT_VERSION } from "../src/prompts.js";

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

test("men: curls at the hairline are not on the forehead, and shaped curly hair is not messy", () => {
  const position = find("MALE", "FORMAL", "M_HAIR_POSITION").rule;
  assert.match(position, /Curls or waves whose front edge sits at the hairline, and hair at the temples or beside the ears, are not on the forehead: FAIL only hair that lies over the forehead skin or the eyebrows\./);
  const neatness = find("MALE", "FORMAL", "M_HAIR_NEATNESS").rule;
  assert.match(neatness, /Natural curly or wavy hair is not messy in itself: judge whether it is combed or shaped and kept under control, and FAIL it on the same terms when it is not\./);

  const prompt = buildSystemPrompt("MALE", "FORMAL");
  assert.match(prompt, /Curls or waves whose front edge\nsits at the hairline, and hair at the temples, are not on the forehead\./);
  assert.match(prompt, /natural curls or waves that are shaped and\nunder control are not messy/);
  assert.doesNotMatch(buildSystemPrompt("FEMALE", "SAREE"), /Curls or waves/);
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
  assert.match(find("FEMALE", "SAREE", "W_SAREE_BLOUSE").rule, /SLEEVELESS BLOUSE IS NOT PERMITTED/);
});

test("women: a half sleeve on a kurti now passes, where it used to fail", () => {
  const rule = find("FEMALE", "KURTI_WITH_DUPATTA", "W_KURTI_NECKLINE_SLEEVES").rule;
  assert.match(rule, /a half sleeve ending at the middle of the upper arm or lower/i);
  assert.doesNotMatch(rule, /half sleeves, cap sleeves and sleeveless are all a FAIL/i);
  assert.doesNotMatch(rule, /requires full or three-quarter length/i);

  const prompt = buildSystemPrompt("FEMALE", "KURTI_WITH_DUPATTA");
  assert.doesNotMatch(prompt, /short, half, cap or sleeveless sleeves is a FAIL/);
  assert.match(prompt, /Sleeves must reach at least halfway from the shoulder to the elbow/);
});

test("women: palazzo passes; leggings, jeggings, churidar and gathered salwar fail", () => {
  const bottom = find("FEMALE", "KURTI_WITH_DUPATTA", "W_BOTTOM_WEAR").rule;
  assert.match(bottom, /^Palazzo pants or straight formal trousers/);
  assert.match(bottom, /FAIL leggings, jeggings and any skin-tight bottom/);
  assert.match(bottom, /FAIL churidar and patiala, dhoti or heavily gathered salwar/);
  assert.doesNotMatch(bottom, /Palazzo, churidar or straight/);

  const formal = find("FEMALE", "FORMAL", "W_FORMAL_BOTTOM_TYPE").rule;
  assert.match(formal, /leggings, jeggings or any skin-tight trousers/);

  const prompt = buildSystemPrompt("FEMALE", "KURTI_WITH_DUPATTA");
  assert.match(prompt, /Leggings, jeggings and other skin-tight bottoms fail, as do churidar/);
});

test("women: the slim straight pants of a kurti set pass; only cloth that clings fails", () => {
  const bottom = find("FEMALE", "KURTI_WITH_DUPATTA", "W_BOTTOM_WEAR").rule;
  assert.match(bottom, /the straight or slim-straight pants of a kurti set - including ankle-length pants that narrow towards the ankle - all pass when the cloth hangs with some ease/);
  assert.match(bottom, /A slim straight pant is not a legging: a pant that matches the kurti, narrows at the ankle, or shows soft creases and a little extra length resting on the shoe still passes\./);
  assert.match(bottom, /FAIL leggings, jeggings and any skin-tight bottom that clings to the leg like a second skin, so that the knee and the calf are fully outlined with no slack in the cloth\./);
  assert.match(bottom, /soft creases at the hem from extra length are not churidar/);
  assert.match(bottom, /Dark or plain cloth that only looks narrow is not proof of a legging: FAIL only when the cloth visibly clings to the leg\./);
  assert.doesNotMatch(bottom, /wider than the leg beneath/);
  assert.doesNotMatch(bottom, /a leg whose shape shows through the cloth, or cloth gathered at the ankle, fails/);

  const prompt = buildSystemPrompt("FEMALE", "KURTI_WITH_DUPATTA");
  assert.match(prompt, /A slim pant is not a legging: fail only\ncloth that visibly clings to the knee and calf with no slack/);
  const men =find("MALE", "FORMAL", "M_TROUSERS_TYPE").rule;
  assert.equal(men, "Formal trousers. FAIL jeans, denim, joggers and obviously casual trousers.");
  assert.doesNotMatch(buildSystemPrompt("MALE", "FORMAL"), /slim pant is not a legging/);
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
  assert.equal(PROMPT_VERSION, "2026-10-05.1");
});
