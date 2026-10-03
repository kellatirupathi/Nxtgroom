import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointSet, improvementTips, maleCombinedSet, SECTION_KEYS } from "../src/checkpoints.js";
import { buildFemaleAttirePrompt, buildMaleReportPrompt, buildSystemPrompt } from "../src/prompts.js";
import { applyBlazer, BLAZER_INSTRUCTIONS, blazerWorn } from "../src/services/blazer.js";

function rowsFor(gender, attire, status = "PASS") {
  const sections = checkpointSet(gender, attire);
  return Object.fromEntries(SECTION_KEYS.map((key) => [key, sections[key].map((item) => ({
    code: item.code,
    checkpoint_name: item.name,
    status,
    observation: "Seen.",
    reason: "Judged.",
  }))]));
}
const find = (rows, code) => SECTION_KEYS.flatMap((key) => rows[key] || []).find((item) => item.code === code);
const codes = (rows) => SECTION_KEYS.flatMap((key) => (rows[key] || []).map((item) => item.code));
const worn = (under = "FORMAL_SHIRT", observation = "A charcoal suit jacket over a white collared shirt.") => ({ worn: true, under, observation });

const MEN_COVERED = ["M_SHIRT_TYPE", "M_SHIRT_FIT", "M_SHIRT_CONDITION", "M_SHIRT_COLLAR_TUCK", "M_BELT"];

test("without a blazer nothing changes and no Blazer / Suit row is shown", () => {
  for (const answer of [undefined, null, { worn: false, under: "NONE", observation: "No blazer or suit jacket." }, { worn: "yes" }, "blazer"]) {
    const rows = rowsFor("MALE", "FORMAL", "FAIL");
    const before = JSON.stringify(rows);
    assert.equal(applyBlazer(rows, { gender: "MALE", attireType: "FORMAL", answer }), null);
    assert.equal(JSON.stringify(rows), before, JSON.stringify(answer));
    assert.equal(blazerWorn(answer), false);
  }
});

test("a man's blazer passes the shirt and belt rows, adds the row, and leaves every other row alone", () => {
  const rows = rowsFor("MALE", "FORMAL", "FAIL");
  const result = applyBlazer(rows, { gender: "MALE", attireType: "FORMAL", answer: worn() });
  assert.deepEqual(result.passed, MEN_COVERED);
  assert.deepEqual(result.failed, []);
  for (const code of MEN_COVERED) {
    const row = find(rows, code);
    assert.equal(row.status, "PASS", code);
    assert.equal(row.observation, "Wearing a blazer or suit over the shirt.");
    assert.match(row.reason, /^Not assessed: /);
  }
  assert.match(find(rows, "M_BELT").reason, /covers the waist and the belt/);
  for (const code of ["M_ATTIRE_TYPE", "M_TROUSERS_TYPE", "M_TROUSERS_FIT_CONDITION", "ID_PRESENT", "M_FACIAL_HAIR", "M_FOOTWEAR_TYPE"]) {
    assert.equal(find(rows, code).status, "FAIL", code);
  }
  const blazer = rows.attire_check.at(-1);
  assert.deepEqual(blazer, {
    code: "M_BLAZER",
    checkpoint_name: "Blazer / Suit",
    status: "PASS",
    observation: "A charcoal suit jacket over a white collared shirt.",
    reason: "Optional. A blazer or suit is worn, so the shirt and belt checkpoints are passed.",
  });
  assert.equal(result.remark, "Wearing a blazer or suit over the shirt; the shirt and belt checks are passed.");
  assert.ok(!improvementTips(rows).some((tip) => /belt|tuck/i.test(tip)));
});

test("a t-shirt or polo under the blazer still fails the shirt type; the rest it covers pass", () => {
  const rows = rowsFor("MALE", "FORMAL");
  const result = applyBlazer(rows, { gender: "MALE", attireType: "FORMAL", answer: worn("T_SHIRT_OR_POLO", "A navy blazer over a grey crew-neck t-shirt.") });
  assert.deepEqual(result.failed, ["M_SHIRT_TYPE"]);
  const shirt = find(rows, "M_SHIRT_TYPE");
  assert.equal(shirt.status, "FAIL");
  assert.equal(shirt.reason, "A t-shirt or polo is worn under the blazer; wear a formal shirt under it.");
  for (const code of MEN_COVERED.slice(1)) assert.equal(find(rows, code).status, "PASS", code);
  assert.equal(result.remark, "Wearing a blazer over a t-shirt or polo.");
});

test("a woman's blazer over shirt and trousers is a suit: Attire Type and the top rows pass", () => {
  const rows = rowsFor("FEMALE", "FORMAL", "FAIL");
  const result = applyBlazer(rows, { gender: "FEMALE", attireType: "FORMAL", answer: worn("FORMAL_SHIRT", "A black blazer over a white blouse.") });
  assert.deepEqual(result.passed.sort(), ["W_FORMAL_ATTIRE_TYPE", "W_FORMAL_TOP", "W_FORMAL_TOP_FIT_CONDITION"]);
  assert.match(find(rows, "W_FORMAL_ATTIRE_TYPE").reason, /accepted as a formal suit/);
  assert.equal(find(rows, "W_FORMAL_TOP").observation, "Wearing a blazer or suit over the top.");
  for (const code of ["W_FORMAL_BOTTOM_TYPE", "W_FORMAL_BOTTOM_FIT_CONDITION", "W_FORMAL_PRESENTATION", "W_HAIR_NEATNESS"]) {
    assert.equal(find(rows, code).status, "FAIL", code);
  }
  assert.equal(rows.attire_check.at(-1).code, "W_BLAZER");
  assert.equal(rows.attire_check.at(-1).reason, "Optional. A blazer or suit is worn, so the top checkpoints are passed.");

  const casual = rowsFor("FEMALE", "FORMAL", "FAIL");
  applyBlazer(casual, { gender: "FEMALE", attireType: "FORMAL", answer: worn("T_SHIRT_OR_POLO") });
  assert.equal(find(casual, "W_FORMAL_TOP").status, "FAIL");
  assert.equal(find(casual, "W_FORMAL_ATTIRE_TYPE").status, "FAIL", "a t-shirt under it is not a suit");
});

test("over a kurta, kurti, saree or abaya the blazer is only recorded", () => {
  for (const [gender, attire] of [["MALE", "KURTA_PAJAMA"], ["FEMALE", "KURTI_WITH_DUPATTA"], ["FEMALE", "SAREE"], ["FEMALE", "ABAYA"]]) {
    const rows = rowsFor(gender, attire, "FAIL");
    const before = rows.attire_check.map((row) => row.code);
    const result = applyBlazer(rows, { gender, attireType: attire, answer: worn("OTHER") });
    assert.deepEqual(result.passed, [], attire);
    assert.deepEqual(rows.attire_check.map((row) => row.code), [...before, gender === "MALE" ? "M_BLAZER" : "W_BLAZER"], attire);
    assert.ok(SECTION_KEYS.flatMap((key) => rows[key]).filter((row) => row.code !== "M_BLAZER" && row.code !== "W_BLAZER").every((row) => row.status === "FAIL"), attire);
    assert.equal(result.remark, "Wearing a blazer or suit.");
  }
});

test("every report request asks about a blazer, in any colour; no checkpoint list changes", () => {
  assert.match(BLAZER_INSTRUCTIONS, /any colour or pattern, buttoned or open, by a man or a woman/);
  assert.match(BLAZER_INSTRUCTIONS, /T_SHIRT_OR_POLO when a t-shirt, a polo or another casual collarless top is clearly visible/);
  assert.match(BLAZER_INSTRUCTIONS, /A blazer is optional and never a failure/);
  for (const prompt of [buildMaleReportPrompt(), buildSystemPrompt("MALE", "FORMAL"), buildSystemPrompt("FEMALE", "FORMAL"), buildSystemPrompt("FEMALE", "SAREE")]) {
    assert.ok(prompt.includes(BLAZER_INSTRUCTIONS));
  }
  assert.match(buildFemaleAttirePrompt(), /including one worn under a blazer or suit jacket/);
  const attire = checkpointSet("MALE", "FORMAL").attire_check.find((row) => row.code === "M_ATTIRE_TYPE").rule;
  assert.match(attire, /A blazer or suit jacket of any colour is acceptable over that combination/);
  assert.doesNotMatch(attire, /navy, grey or black/);
  const women = checkpointSet("FEMALE", "FORMAL").attire_check.find((row) => row.code === "W_FORMAL_ATTIRE_TYPE").rule;
  assert.match(women, /^Shirt and trousers are not permitted for women/);
  assert.match(women, /The one exception is a blazer or suit jacket worn over them, which makes an accepted suit: then PASS\./);
  for (const sections of [checkpointSet("MALE", "FORMAL"), checkpointSet("FEMALE", "FORMAL"), maleCombinedSet()]) {
    assert.ok(!codes(sections).some((code) => /BLAZER/.test(code)));
  }
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

function report(sections, { failing = [], extra = {} } = {}) {
  const body = { subject_visible: true, image_quality: "ADEQUATE", ai_summary: "Belt and tuck not visible.", visible_regions: VISIBLE, ...extra };
  for (const key of SECTION_KEYS) {
    if (!sections[key].length) continue;
    body[key] = Object.fromEntries(sections[key].map((item) => [item.code, {
      status: failing.includes(item.code) ? "FAIL" : "PASS",
      observation: "Seen.",
      reason: "Judged.",
    }]));
  }
  return body;
}

const image = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

test("a man in a suit is compliant though the model failed the belt and tuck it could not see", async () => {
  const sections = maleCombinedSet();
  const stub = stubGemini([report(sections, {
    failing: ["M_BELT", "M_SHIRT_COLLAR_TUCK"],
    extra: { attire_type: "FORMAL", blazer: worn() },
  })]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(image(), "image/jpeg", "MALE");
    assert.equal(result.overall_status, "COMPLIANT");
    assert.equal(result.attire_check.find((row) => row.code === "M_BELT").status, "PASS");
    assert.equal(result.attire_check.at(-1).code, "M_BLAZER");
    assert.match(result.ai_summary, /^Wearing a blazer or suit over the shirt; the shirt and belt checks are passed\. Belt and tuck/);
    const schema = stub.bodies[0].generationConfig.responseJsonSchema;
    assert.ok(schema.required.includes("blazer"));
    assert.deepEqual(schema.properties.blazer.required, ["worn", "under", "observation"]);
  } finally {
    stub.restore();
  }
});

test("a man without a blazer is judged as before, with no Blazer / Suit row", async () => {
  const sections = maleCombinedSet();
  const stub = stubGemini([report(sections, {
    failing: ["M_BELT"],
    extra: { attire_type: "FORMAL", blazer: { worn: false, under: "NONE", observation: "No blazer or suit jacket." } },
  })]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(image(), "image/jpeg", "MALE");
    assert.equal(result.overall_status, "NON_COMPLIANT");
    assert.equal(result.attire_check.find((row) => row.code === "M_BELT").status, "FAIL");
    assert.ok(!result.attire_check.some((row) => row.code === "M_BLAZER"));
    assert.equal(result.ai_summary, "Belt and tuck not visible.");
  } finally {
    stub.restore();
  }
});

test("a woman in a trouser suit is compliant; without the blazer shirt and trousers still fail", async () => {
  const sections = checkpointSet("FEMALE", "FORMAL");
  const classified = { subject_visible: true, attire_type: "FORMAL", image_quality: "ADEQUATE", visible_regions: VISIBLE };
  const { evaluateImage } = await import("../src/services/visionEngine.js");

  let stub = stubGemini([classified, report(sections, { extra: { blazer: worn("FORMAL_SHIRT", "A grey blazer over a white blouse.") } })]);
  try {
    const result = await evaluateImage(image(), "image/jpeg", "FEMALE");
    assert.equal(result.overall_status, "COMPLIANT");
    assert.equal(result.attire_check.find((row) => row.code === "W_FORMAL_ATTIRE_TYPE").status, "PASS");
    assert.equal(result.attire_check.at(-1).code, "W_BLAZER");
    assert.doesNotMatch(result.ai_summary, /not permitted for women/);
    assert.ok(stub.bodies[1].generationConfig.responseJsonSchema.required.includes("blazer"));
  } finally {
    stub.restore();
  }

  stub = stubGemini([classified, report(sections, { extra: { blazer: { worn: false, under: "NONE", observation: "No blazer or suit jacket." } } })]);
  try {
    const result = await evaluateImage(image(), "image/jpeg", "FEMALE");
    assert.equal(result.overall_status, "NON_COMPLIANT");
    assert.equal(result.attire_check.find((row) => row.code === "W_FORMAL_ATTIRE_TYPE").status, "FAIL");
    assert.ok(!result.attire_check.some((row) => row.code === "W_BLAZER"));
    assert.match(result.ai_summary, /^Shirt and trousers are not permitted for women/);
  } finally {
    stub.restore();
  }
});
