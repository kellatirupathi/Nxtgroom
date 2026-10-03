import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  ABAYA_SKIPPED_GROOMING,
  checkpointSet,
  IMPROVEMENT_TIPS,
  INFORMATIONAL_CODES,
  KURTA_SKIPPED_GROOMING,
  MALE_ATTIRE_TYPES,
  maleCombinedSet,
  SECTION_KEYS,
} from "../src/checkpoints.js";
import { buildFemaleAttirePrompt, buildMaleReportPrompt, buildSystemPrompt } from "../src/prompts.js";
import { weeklyRotation } from "../src/services/instructorReports.js";

const codes = (sections) => SECTION_KEYS.flatMap((key) => sections[key].map((item) => item.code));

test("every family that existed before keeps every one of its checkpoints", () => {
  assert.equal(codes(checkpointSet("MALE", "FORMAL")).length, 21);
  assert.equal(codes(checkpointSet("MALE")).length, 21, "no family named is still formal");
  assert.equal(codes(checkpointSet("FEMALE", "SAREE")).length, 20);
  assert.equal(codes(checkpointSet("FEMALE", "KURTI_WITH_DUPATTA")).length, 21);
  assert.equal(codes(checkpointSet("FEMALE", "FORMAL")).length, 20);
  for (const code of ["M_FACIAL_HAIR", "M_MOUSTACHE", "M_BELT", "M_SHIRT_COLLAR_TUCK"]) {
    assert.ok(codes(checkpointSet("MALE", "FORMAL")).includes(code), code);
  }
  for (const code of ["W_HAIR_NEATNESS", "W_HAIR_POSITION", "W_HAIR_ACCESSORIES"]) {
    assert.ok(codes(checkpointSet("FEMALE", "SAREE")).includes(code), code);
  }
});

test("a kurta keeps ID, accessories and footwear, and drops hair, beard, headwear and the shirt rows", () => {
  const kurta = codes(checkpointSet("MALE", "KURTA_PAJAMA"));
  assert.deepEqual(KURTA_SKIPPED_GROOMING, ["M_HAIR_NEATNESS", "M_HAIR_POSITION", "M_HAIR_LENGTH", "M_FACIAL_HAIR", "M_MOUSTACHE"]);
  for (const code of ["ID_PRESENT", "M_RINGS", "M_FOOTWEAR_TYPE",
    "M_KURTA_ATTIRE_TYPE", "M_KURTA_BOTTOM", "M_KURTA_CONDITION", "M_PRAYER_CAP"]) {
    assert.ok(kurta.includes(code), code);
  }
  assert.equal(kurta.length, 11);
  assert.deepEqual(checkpointSet("MALE", "KURTA_PAJAMA").grooming_check, [], "no grooming row at all");
  for (const code of ["M_HAIR_NEATNESS", "M_HAIR_POSITION", "M_HAIR_LENGTH", "M_FACIAL_HAIR", "M_MOUSTACHE",
    "M_BELT", "M_SHIRT_COLLAR_TUCK", "M_TROUSERS_TYPE", "M_HEADWEAR"]) {
    assert.ok(!kurta.includes(code), code);
  }
  const attire = checkpointSet("MALE", "KURTA_PAJAMA").attire_check;
  const bottom = attire.find((item) => item.code === "M_KURTA_BOTTOM");
  assert.match(bottom.rule, /FAIL jeans and denim of any colour, including black jeans/);
  const condition = attire.find((item) => item.code === "M_KURTA_CONDITION");
  assert.match(condition.rule, /FAIL only visible stains, tears or fraying\. Do not judge pressing or creases/);
  assert.match(attire.find((item) => item.code === "M_KURTA_ATTIRE_TYPE").rule, /Do not apply the formal shirt-and-trousers standards to a kurta/);
});

test("an abaya keeps makeup, nails, ID, accessories and footwear, and drops every hair row", () => {
  const abaya = codes(checkpointSet("FEMALE", "ABAYA"));
  assert.deepEqual(ABAYA_SKIPPED_GROOMING, ["W_HAIR_NEATNESS", "W_HAIR_POSITION", "W_HAIR_ACCESSORIES"]);
  for (const code of ["W_MAKEUP", "W_NAILS", "ID_PRESENT", "W_EARRINGS", "W_FOOTWEAR_TYPE",
    "W_ABAYA_ATTIRE_TYPE", "W_ABAYA_FIT_LENGTH", "W_ABAYA_CONDITION", "W_HEAD_SCARF"]) {
    assert.ok(abaya.includes(code), code);
  }
  for (const code of ABAYA_SKIPPED_GROOMING) assert.ok(!abaya.includes(code), code);
});

test("the cap and the scarf are recorded but never scored, and every scored row has a tip", () => {
  assert.ok(INFORMATIONAL_CODES.has("M_PRAYER_CAP"));
  assert.ok(INFORMATIONAL_CODES.has("W_HEAD_SCARF"));
  assert.ok(INFORMATIONAL_CODES.has("M_WATCH") && INFORMATIONAL_CODES.has("W_WATCH"), "the existing ones stay");
  const families = [["MALE", "FORMAL"], ["MALE", "KURTA_PAJAMA"], ["FEMALE", "SAREE"], ["FEMALE", "KURTI_WITH_DUPATTA"], ["FEMALE", "FORMAL"], ["FEMALE", "ABAYA"]];
  for (const [gender, attire] of families) {
    for (const code of codes(checkpointSet(gender, attire))) {
      if (!INFORMATIONAL_CODES.has(code)) assert.ok(IMPROVEMENT_TIPS[code], `${code} has no tip`);
    }
  }
});

test("a man's one request asks for both families' rows", () => {
  assert.deepEqual(MALE_ATTIRE_TYPES, ["FORMAL", "KURTA_PAJAMA"]);
  const combined = codes(maleCombinedSet());
  assert.equal(combined.length, 25);
  for (const code of [...codes(checkpointSet("MALE", "FORMAL")), ...codes(checkpointSet("MALE", "KURTA_PAJAMA"))]) {
    assert.ok(combined.includes(code), code);
  }
});

test("the beard and moustache rules gain their allowances without losing their standards", () => {
  const grooming = checkpointSet("MALE", "FORMAL").grooming_check;
  const beard = grooming.find((item) => item.code === "M_FACIAL_HAIR").rule;
  assert.match(beard, /Light, even stubble or a negligible beard too short to have a shaped edge is groomed and passes/);
  assert.match(beard, /FAIL an untrimmed or grown-out beard/, "the existing standard is kept");
  assert.match(beard, /if you cannot point to a specific groomed edge, the correct answer is FAIL/);
  const moustache = grooming.find((item) => item.code === "M_MOUSTACHE").rule;
  assert.match(moustache, /A thin, light or short moustache that stays above the lip line passes/);
  assert.match(moustache, /FAIL a moustache whose hair grows down over the lip line/);
});

test("the women's classification can name an abaya, and her report then asks no hair rows", () => {
  const classification = buildFemaleAttirePrompt();
  assert.match(classification, /- ABAYA: an abaya is being worn/);
  for (const family of ["- SAREE:", "- KURTI_WITH_DUPATTA:", "- FORMAL:", "- UNKNOWN:"]) {
    assert.ok(classification.includes(family), family);
  }
  const report = buildSystemPrompt("FEMALE", "ABAYA");
  assert.match(report, /W_ABAYA_ATTIRE_TYPE/);
  assert.doesNotMatch(report, /W_HAIR_NEATNESS/);
  assert.match(report, /### ABAYA/);
});

test("the men's report prompt chooses the family; the formal prompt is still there for the fallback", () => {
  const prompt = buildMaleReportPrompt();
  assert.match(prompt, /### WHICH ATTIRE FAMILY/);
  assert.match(prompt, /KURTA_PAJAMA: a long kurta/);
  assert.match(prompt, /no others: 25 in total/);
  assert.match(prompt, /answer Hair Neatness, Hair Position,\nHair Length, Facial Hair, Moustache and Headwear N\/A/);
  const formal = buildSystemPrompt("MALE", "FORMAL");
  assert.match(formal, /no others: 21 in total/);
  assert.doesNotMatch(formal, /M_KURTA/);
});

test("an abaya week is not scored against the saree/kurti rotation", () => {
  const week = { gender: "FEMALE", sareeDays: 2, kurtiDays: 2, unknownDays: 0, weekComplete: true };
  assert.equal(weeklyRotation(week).status, "FAIL", "unchanged without an abaya day");
  const abaya = weeklyRotation({ ...week, abayaDays: 2 });
  assert.equal(abaya.status, "NOT_APPLICABLE");
  assert.equal(abaya.abaya_days, 2);
  assert.equal(weeklyRotation({ ...week, sareeDays: 3, kurtiDays: 3 }).status, "PASS");
  assert.equal(weeklyRotation({ ...week, gender: "MALE", abayaDays: 0 }), null);
});

function stubGemini(responses) {
  const GEMINI_ENV = ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_TIMEOUT_MS", "GEMINI_MAX_RETRIES", "GEMINI_EXPLICIT_CACHE"];
  const original = Object.fromEntries(GEMINI_ENV.map((name) => [name, process.env[name]]));
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
    if (next?.status) {
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

function reply(sections, extra = {}, status = () => "PASS") {
  const body = { subject_visible: true, image_quality: "ADEQUATE", ai_summary: "Seen.", visible_regions: VISIBLE, ...extra };
  for (const key of SECTION_KEYS) {
    if (!sections[key].length) continue;
    body[key] = Object.fromEntries(sections[key].map((item) => [item.code, { status: status(item.code), observation: "Seen.", reason: "Seen." }]));
  }
  return body;
}

async function photo() {
  return sharp({ create: { width: 600, height: 900, channels: 3, background: "#d8d2c4" } }).jpeg().toBuffer();
}

test("a man in a kurta is reported on the kurta's rows, without the beard, from one request", async () => {
  const kurtaCodes = new Set(codes(checkpointSet("MALE", "KURTA_PAJAMA")));
  const stub = stubGemini([reply(maleCombinedSet(), { attire_type: "KURTA_PAJAMA" }, (code) => (kurtaCodes.has(code) ? "PASS" : "N/A"))]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(await photo(), "image/jpeg", "MALE");
    assert.equal(stub.bodies.length, 1);
    assert.deepEqual(stub.bodies[0].generationConfig.responseJsonSchema.properties.attire_type.enum, ["FORMAL", "KURTA_PAJAMA"]);
    assert.equal(result.attire_type, "KURTA_PAJAMA");
    assert.equal(result.overall_status, "COMPLIANT");
    const reported = SECTION_KEYS.flatMap((key) => result[key].map((item) => item.code));
    assert.deepEqual(reported.sort(), [...kurtaCodes].sort());
    assert.ok(!reported.includes("M_FACIAL_HAIR") && !reported.includes("M_BELT"));
  } finally {
    stub.restore();
  }
});

test("a man in formal wear is reported exactly as before, on the formal rows", async () => {
  const formalCodes = new Set(codes(checkpointSet("MALE", "FORMAL")));
  const stub = stubGemini([reply(maleCombinedSet(), { attire_type: "FORMAL" }, (code) => (formalCodes.has(code) ? "PASS" : "N/A"))]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(await photo(), "image/jpeg", "MALE");
    assert.equal(result.attire_type, "FORMAL");
    const reported = SECTION_KEYS.flatMap((key) => result[key].map((item) => item.code));
    assert.deepEqual(reported.sort(), [...formalCodes].sort());
  } finally {
    stub.restore();
  }
});

test("a refused combined request falls back to exactly the formal request used before", async () => {
  const stub = stubGemini([
    { status: 400, message: "the specified schema produces a constraint that has too many states for serving" },
    reply(checkpointSet("MALE", "FORMAL")),
  ]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(await photo(), "image/jpeg", "MALE", undefined, { bodyRegions: { waist: [480, 330, 560, 640] } });
    assert.equal(stub.bodies.length, 2);
    const fallback = stub.bodies[1];
    assert.ok(!fallback.generationConfig.responseJsonSchema.required.includes("close_up"));
    assert.equal(fallback.generationConfig.responseJsonSchema.properties.attire_type, undefined);
    assert.match(fallback.systemInstruction.parts[0].text, /no others: 21 in total/);
    assert.equal(fallback.contents[0].parts.filter((part) => part.inlineData).length, 1);
    assert.equal(result.attire_type, "FORMAL");
    assert.equal(result.overall_status, "COMPLIANT");
  } finally {
    stub.restore();
  }
});

test("a reply missing a row of the family it chose is refused, not half-reported", async () => {
  const partial = reply(maleCombinedSet(), { attire_type: "KURTA_PAJAMA" });
  delete partial.attire_check.M_KURTA_BOTTOM;
  const stub = stubGemini([partial]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    await assert.rejects(evaluateImage(await photo(), "image/jpeg", "MALE"), (error) => error.code === "GEMINI_INVALID_RESPONSE");
  } finally {
    stub.restore();
  }
});

test("a woman in an abaya is classified, then reported without any hair row", async () => {
  const stub = stubGemini([
    { subject_visible: true, attire_type: "ABAYA", image_quality: "ADEQUATE", visible_regions: VISIBLE },
    reply(checkpointSet("FEMALE", "ABAYA")),
  ]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(await photo(), "image/jpeg", "FEMALE");
    assert.equal(stub.bodies.length, 2, "the same two requests as every woman's report");
    assert.ok(stub.bodies[0].generationConfig.responseJsonSchema.properties.attire_type.enum.includes("ABAYA"));
    assert.equal(result.attire_type, "ABAYA");
    assert.equal(result.overall_status, "COMPLIANT");
    assert.deepEqual(result.grooming_check.map((item) => item.code), ["W_MAKEUP", "W_NAILS"]);
    assert.equal(result.detail_check, undefined, "the close-up is a men's check");
  } finally {
    stub.restore();
  }
});

test("caps and hats fail for everyone except the kurta family; religious coverings pass", () => {
  for (const [gender, attire, code] of [
    ["MALE", "FORMAL", "M_HEADWEAR"],
    ["FEMALE", "SAREE", "W_HEADWEAR"],
    ["FEMALE", "KURTI_WITH_DUPATTA", "W_HEADWEAR"],
    ["FEMALE", "FORMAL", "W_HEADWEAR"],
    ["FEMALE", "ABAYA", "W_HEADWEAR"],
  ]) {
    const row = checkpointSet(gender, attire).accessories_check.find((item) => item.code === code);
    assert.ok(row, `${gender} ${attire}`);
    assert.match(row.rule, /FAIL a baseball cap, sports or snapback cap, beanie/);
    assert.ok(row.rule.includes("PASS: a prayer cap (topi or kufi), a turban or patka, and a hijab or head scarf"));
    assert.ok(!INFORMATIONAL_CODES.has(code), "it is scored");
    assert.equal(IMPROVEMENT_TIPS[code], "Remove the cap or hat before checking in.");
    assert.match(buildSystemPrompt(gender, attire), new RegExp(`code: ${code}`));
  }
  const kurta = checkpointSet("MALE", "KURTA_PAJAMA");
  assert.equal(kurta.accessories_check.find((item) => item.code === "M_HEADWEAR"), undefined);
  assert.ok(kurta.attire_check.find((item) => item.code === "M_PRAYER_CAP"));
});

test("a short, close-cropped beard of even length passes without shaved edge lines", async () => {
  const beard = checkpointSet("MALE", "FORMAL").grooming_check.find((item) => item.code === "M_FACIAL_HAIR").rule;
  assert.match(beard, /a short close-cropped beard of even length/);
  assert.match(beard, /passes even when its cheek line and neckline follow the natural growth rather than a shaved edge: do not fail it for an undefined edge, and do not call it overgrown because it covers the jaw and chin/);
  assert.match(beard, /A beard longer than that is groomed only when its outer edges are defined/);
  assert.match(beard, /FAIL an untrimmed or grown-out beard - long, bushy or full enough to stand away from the face/);
  assert.doesNotMatch(beard, /a short one with ragged edges fails/);

  const { CLOSE_UP_INSTRUCTIONS } = await import("../src/services/detailCheck.js");
  assert.match(CLOSE_UP_INSTRUCTIONS, /TRIMMED_BEARD for a short, close-cropped beard of even length/);
  assert.match(CLOSE_UP_INSTRUCTIONS, /A short, even beard is TRIMMED_BEARD, never UNTRIMMED_BEARD/);
});
