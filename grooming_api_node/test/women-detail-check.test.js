import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { checkpointSet, IMPROVEMENT_TIPS, SECTION_KEYS } from "../src/checkpoints.js";
import { buildFemaleAttirePrompt, buildSystemPrompt } from "../src/prompts.js";
import {
  applyWomenContradictions,
  applyWomenFindings,
  buildWomenCloseUps,
  sleeveVerdict,
  WOMEN_CLOSE_UP_INSTRUCTIONS,
  WOMEN_DETAIL_CHECK_VERSION,
} from "../src/services/womenDetailCheck.js";

const rule = (attire, code) => SECTION_KEYS
  .flatMap((key) => checkpointSet("FEMALE", attire)[key])
  .find((item) => item.code === code).rule;

const row = (rows, code) => SECTION_KEYS.flatMap((key) => rows[key] || []).find((item) => item.code === code);

function rowsFor(attire, overrides = {}) {
  const sections = checkpointSet("FEMALE", attire);
  const rows = {};
  for (const key of SECTION_KEYS) {
    rows[key] = sections[key].map((item) => ({
      code: item.code,
      checkpoint_name: item.name,
      status: "PASS",
      observation: "Seen and acceptable.",
      reason: "Meets the standard.",
      ...(overrides[item.code] || {}),
    }));
  }
  return rows;
}

const ANSWER = {
  sleeve_left: "AT_ELBOW",
  sleeve_right: "NOT_VISIBLE",
  sleeve_observation: "Black printed sleeves end at the elbow.",
  print: "PLAIN",
  print_observation: "A plain blue saree.",
  dupatta: "BOTH_SHOULDERS",
  dupatta_observation: "The dupatta covers both shoulders.",
  footwear: "CLOSED_TOE",
  footwear_observation: "Black closed-toe bellies; the toes are covered.",
  earrings: "UP_TO_2CM",
  earrings_observation: "Small studs.",
  fit: "NORMAL_EASE",
  fit_observation: "The shoulder seam sits on the shoulder.",
};

test("women's written rules: closed-toe footwear only, noticeable prints fail, dupatta on both shoulders, a defined fit", () => {
  const footwear = rule("KURTI_WITH_DUPATTA", "W_FOOTWEAR_TYPE");
  assert.match(footwear, /^Only closed-toe formal footwear passes/);
  assert.match(footwear, /FAIL every open-toe style - all sandals, including formal sandals with a back or ankle strap/);
  assert.match(footwear, /Never call footwear closed-toe when the toes can be seen/);
  assert.doesNotMatch(footwear, /formal open-toe sandals with a back or ankle strap all pass/);

  const material = rule("KURTI_WITH_DUPATTA", "W_KURTI_MATERIAL");
  assert.match(material, /FAIL a loud or noticeable print or pattern - floral, botanical/);
  assert.match(material, /A tiny, subtle pattern \(small dots or buttis that read as plain at a glance\) passes/);

  assert.match(rule("KURTI_WITH_DUPATTA", "W_DUPATTA"), /The dupatta must cover both shoulders/);
  assert.match(rule("KURTI_WITH_DUPATTA", "W_KURTI_FIT_LENGTH"), /FAIL a loose or oversized kurti/);
  assert.match(rule("SAREE", "W_EARRINGS"), /never call a drop or jhumka a stud/);

  assert.match(IMPROVEMENT_TIPS.W_FOOTWEAR_TYPE, /sandals and slippers are not permitted/);
  assert.match(IMPROVEMENT_TIPS.W_DUPATTA, /over both shoulders/);

  const prompt = buildSystemPrompt("FEMALE", "KURTI_WITH_DUPATTA");
  assert.match(prompt, /Footwear must be closed-toe/);
  assert.match(prompt, /must cover both shoulders/);
  assert.match(buildFemaleAttirePrompt(), /### WHERE THE PARTS ARE \(region_boxes\)/);
  assert.match(WOMEN_CLOSE_UP_INSTRUCTIONS, /OPEN_TOE_SANDALS for any sandal with the toes showing, including formal strap sandals/);
});

test("the sleeve verdict is decided by code from where each hem ends, using the arm that can be seen", () => {
  assert.equal(sleeveVerdict("AT_ELBOW", "NOT_VISIBLE"), "PASS");
  assert.equal(sleeveVerdict("MIDDLE_OF_UPPER_ARM", "MIDDLE_OF_UPPER_ARM"), "PASS");
  assert.equal(sleeveVerdict("CAP", "ABOVE_MIDDLE"), "FAIL");
  assert.equal(sleeveVerdict("SLEEVELESS", "NOT_VISIBLE"), "FAIL");
  assert.equal(sleeveVerdict("NOT_VISIBLE", "NOT_VISIBLE"), null);
  assert.equal(sleeveVerdict("CAP", "BELOW_ELBOW"), "PASS", "one long sleeve shows the blouse is not short");
});

test("an elbow-length blouse the report failed as short is passed on the arm close-up, and so is its presentation", () => {
  const rows = rowsFor("SAREE", {
    W_SAREE_BLOUSE: {
      status: "FAIL",
      observation: "The blouse has short sleeves that end at the shoulder or upper bicep.",
      reason: "The sleeve hem does not reach at least halfway from the shoulder to the elbow.",
    },
    W_SAREE_PRESENTATION: {
      status: "FAIL",
      observation: "The overall presentation is compromised by the non-compliant blouse sleeve length.",
      reason: "The blouse sleeve length violates the standard.",
    },
  });
  const { passed, failed } = applyWomenFindings(rows, ANSWER, { attireType: "SAREE", boxes: { upper_body: [100, 200, 500, 800] } });
  assert.deepEqual(passed, ["W_SAREE_BLOUSE", "W_SAREE_PRESENTATION"]);
  assert.deepEqual(failed, []);
  assert.equal(row(rows, "W_SAREE_BLOUSE").status, "PASS");
  assert.match(row(rows, "W_SAREE_BLOUSE").observation, /^Close-up of the shoulders and arms: Black printed sleeves end at the elbow\./);
  assert.equal(row(rows, "W_SAREE_BLOUSE").evidence_label, "Close-up of the shoulders and arms");
  assert.equal(row(rows, "W_SAREE_PRESENTATION").status, "PASS");
});

test("a blouse failed for another reason is not passed just because the sleeves are long", () => {
  const rows = rowsFor("SAREE", {
    W_SAREE_BLOUSE: { status: "FAIL", observation: "Long sleeves, but a safety pin is visible at the shoulder.", reason: "Visible safety pin." },
  });
  applyWomenFindings(rows, ANSWER, { attireType: "SAREE" });
  assert.equal(row(rows, "W_SAREE_BLOUSE").status, "FAIL");
});

test("a sleeve the close-up shows short fails even when the report passed it", () => {
  const rows = rowsFor("KURTI_WITH_DUPATTA");
  const { failed } = applyWomenFindings(rows, { ...ANSWER, sleeve_left: "CAP", sleeve_right: "CAP" }, { attireType: "KURTI_WITH_DUPATTA" });
  assert.ok(failed.includes("W_KURTI_NECKLINE_SLEEVES"));
  assert.equal(row(rows, "W_KURTI_NECKLINE_SLEEVES").status, "FAIL");
});

test("the 13 Oct kurti report: a floral print and open sandals described but passed now fail", () => {
  const rows = rowsFor("KURTI_WITH_DUPATTA", {
    W_KURTI_MATERIAL: { observation: "The kurti fabric is opaque and has a professional appearance with a floral print." },
    W_FOOTWEAR_TYPE: {
      observation: "The instructor is wearing brown flat sandals with a back strap.",
      reason: "The footwear appears to be professional and closed-toe with a back strap.",
    },
    W_BOTTOM_WEAR: { observation: "The instructor is wearing white leggings." },
  });
  const failed = applyWomenContradictions(rows);
  assert.deepEqual(failed.sort(), ["W_BOTTOM_WEAR", "W_FOOTWEAR_TYPE", "W_KURTI_MATERIAL"]);
  assert.match(row(rows, "W_FOOTWEAR_TYPE").reason, /only closed-toe formal footwear is permitted/);
  assert.match(row(rows, "W_KURTI_MATERIAL").reason, /plain, solid-colour kurti is required/);
});

test("the contradiction check respects negation and tiny patterns", () => {
  const rows = rowsFor("KURTI_WITH_DUPATTA", {
    W_FOOTWEAR_TYPE: { observation: "Black closed-toe bellies, not sandals." },
    W_KURTI_MATERIAL: { observation: "A plain kurti with tiny printed buttis that read as plain." },
    W_BOTTOM_WEAR: { observation: "Straight palazzo pants, without leggings." },
  });
  assert.deepEqual(applyWomenContradictions(rows), []);
});

test("the close-up fails one-shoulder dupattas, open sandals, large earrings and oversized kurtis, and never passes a failure", () => {
  const rows = rowsFor("KURTI_WITH_DUPATTA", { W_BOTTOM_WEAR: { status: "FAIL" } });
  const { failed } = applyWomenFindings(rows, {
    ...ANSWER,
    print: "NOTICEABLE_PRINT",
    dupatta: "ONE_SHOULDER",
    footwear: "OPEN_TOE_SANDALS",
    earrings: "LARGER_THAN_2CM",
    fit: "LOOSE_OVERSIZED",
  }, { attireType: "KURTI_WITH_DUPATTA" });
  assert.deepEqual(failed.sort(), ["W_DUPATTA", "W_EARRINGS", "W_FOOTWEAR_TYPE", "W_KURTI_FIT_LENGTH", "W_KURTI_MATERIAL"]);
  assert.equal(row(rows, "W_DUPATTA").reason, "The dupatta covers only one shoulder; it must cover both shoulders.");
  assert.equal(row(rows, "W_BOTTOM_WEAR").status, "FAIL");

  const clean = rowsFor("KURTI_WITH_DUPATTA", { W_FOOTWEAR_TYPE: { status: "FAIL", reason: "Sandals." } });
  applyWomenFindings(clean, ANSWER, { attireType: "KURTI_WITH_DUPATTA" });
  assert.equal(row(clean, "W_FOOTWEAR_TYPE").status, "FAIL", "only the sleeve finding may turn a FAIL into a PASS");
});

test("close-ups are cut from the region boxes the first request reports", async () => {
  const photo = await sharp({ create: { width: 600, height: 900, channels: 3, background: "#d8d2c4" } }).jpeg().toBuffer();
  const built = await buildWomenCloseUps(photo, {
    head_box: [40, 380, 180, 620],
    upper_body_box: [150, 250, 520, 750],
    feet_box: [860, 330, 990, 670],
  });
  assert.deepEqual(Object.keys(built.boxes), ["head", "upper_body", "feet"]);
  assert.ok(Buffer.isBuffer(built.armImage));
  assert.equal(built.parts.filter((part) => part.type === "input_image").length, 3);
  assert.equal((await buildWomenCloseUps(photo, undefined)).parts.length, 0);
  assert.equal((await buildWomenCloseUps(photo, { head_box: [0, 0, 0, 0], upper_body_box: [0, 0, 0, 0], feet_box: [0, 0, 0, 0] })).parts.length, 0);
});

function stubGemini(responses) {
  const NAMES = ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_TIMEOUT_MS", "GEMINI_MAX_RETRIES", "GEMINI_EXPLICIT_CACHE"];
  const original = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-only-gemini-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";
  process.env.GEMINI_TIMEOUT_MS = "120000";
  process.env.GEMINI_MAX_RETRIES = "0";
  process.env.GEMINI_EXPLICIT_CACHE = "false";
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    const next = responses[bodies.length - 1];
    if (!next) throw new Error(`unexpected Gemini request #${bodies.length}`);
    if (next.status) {
      return new Response(JSON.stringify({ error: { message: next.message } }), { status: next.status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(next) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    bodies,
    restore() {
      globalThis.fetch = originalFetch;
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

const VISIBLE = { face: "VISIBLE", upper_body: "VISIBLE", lower_body: "VISIBLE", footwear: "VISIBLE", id_card: "VISIBLE", hands: "VISIBLE" };
const BOXES = { head_box: [40, 380, 180, 620], upper_body_box: [150, 250, 520, 750], feet_box: [860, 330, 990, 670] };

function sareeReport(extra = {}) {
  const sections = checkpointSet("FEMALE", "SAREE");
  const body = { subject_visible: true, image_quality: "ADEQUATE", ai_summary: "Seen.", visible_regions: VISIBLE, ...extra };
  for (const key of SECTION_KEYS) {
    if (!sections[key].length) continue;
    body[key] = Object.fromEntries(sections[key].map((item) => [item.code, { status: "PASS", observation: "Seen.", reason: "Seen." }]));
  }
  body.attire_check.W_SAREE_BLOUSE = {
    status: "FAIL",
    observation: "The blouse has short sleeves that end at the shoulder or upper bicep.",
    reason: "The sleeve hem does not reach at least halfway from the shoulder to the elbow.",
  };
  return body;
}

const photo = () => sharp({ create: { width: 600, height: 900, channels: 3, background: "#d8d2c4" } }).jpeg().toBuffer();

test("a sleeve failure gets a second look at the arm close-up, which clears it when the sleeves reach the elbow", async () => {
  const stub = stubGemini([
    { subject_visible: true, attire_type: "SAREE", image_quality: "ADEQUATE", visible_regions: VISIBLE, region_boxes: BOXES },
    sareeReport({ women_close_up: { ...ANSWER, sleeve_left: "ABOVE_MIDDLE", sleeve_right: "NOT_VISIBLE" } }),
    { sleeve_left: "AT_ELBOW", sleeve_right: "NOT_VISIBLE", observation: "Black printed sleeves reach the elbow." },
  ]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(await photo(), "image/jpeg", "FEMALE");
    assert.equal(stub.bodies.length, 3);
    const report = stub.bodies[1];
    assert.ok(report.generationConfig.responseJsonSchema.required.includes("women_close_up"));
    assert.equal(report.contents[0].parts.filter((part) => part.inlineData).length, 4, "the photo and three close-ups");
    const second = stub.bodies[2];
    assert.equal(second.contents[0].parts.filter((part) => part.inlineData).length, 1, "only the arm close-up");
    assert.match(second.systemInstruction.parts[0].text, /where does the hem of each sleeve end on the arm/);

    const blouse = result.attire_check.find((item) => item.code === "W_SAREE_BLOUSE");
    assert.equal(blouse.status, "PASS");
    assert.match(blouse.observation, /^Second look at the close-up of the shoulders and arms: Black printed sleeves reach the elbow\./);
    assert.equal(result.overall_status, "COMPLIANT");
    assert.equal(result.detail_check.version, WOMEN_DETAIL_CHECK_VERSION);
    assert.equal(result.detail_check.sleeve_second_look, "PASS");
    assert.deepEqual(result.detail_check.crops, ["head", "upper_body", "feet"]);
  } finally {
    stub.restore();
  }
});

test("a sleeve failure the second look confirms stays a failure", async () => {
  const stub = stubGemini([
    { subject_visible: true, attire_type: "SAREE", image_quality: "ADEQUATE", visible_regions: VISIBLE, region_boxes: BOXES },
    sareeReport({ women_close_up: { ...ANSWER, sleeve_left: "CAP", sleeve_right: "CAP" } }),
    { sleeve_left: "CAP", sleeve_right: "CAP", observation: "Cap sleeves just below the shoulder." },
  ]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(await photo(), "image/jpeg", "FEMALE");
    assert.equal(result.attire_check.find((item) => item.code === "W_SAREE_BLOUSE").status, "FAIL");
    assert.equal(result.overall_status, "NON_COMPLIANT");
    assert.equal(result.detail_check.sleeve_second_look, "FAIL");
  } finally {
    stub.restore();
  }
});

test("a refused women's close-up request falls back to the report used before", async () => {
  const stub = stubGemini([
    { subject_visible: true, attire_type: "SAREE", image_quality: "ADEQUATE", visible_regions: VISIBLE, region_boxes: BOXES },
    { status: 400, message: "the specified schema produces a constraint that has too many states for serving" },
    sareeReport(),
  ]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(await photo(), "image/jpeg", "FEMALE");
    assert.equal(stub.bodies.length, 3, "no second look without an arm close-up");
    const fallback = stub.bodies[2];
    assert.ok(!fallback.generationConfig.responseJsonSchema.required.includes("women_close_up"));
    assert.equal(fallback.contents[0].parts.filter((part) => part.inlineData).length, 1);
    assert.equal(result.attire_check.find((item) => item.code === "W_SAREE_BLOUSE").status, "FAIL");
    assert.deepEqual(result.detail_check.crops, []);
  } finally {
    stub.restore();
  }
});
