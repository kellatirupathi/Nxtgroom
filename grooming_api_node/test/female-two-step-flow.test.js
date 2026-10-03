import assert from "node:assert/strict";
import { test } from "node:test";

const GEMINI_ENV = [
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_TIMEOUT_MS",
  "GEMINI_MAX_RETRIES",
  "GEMINI_EXPLICIT_CACHE",
];

function withStubbedGemini(responses) {
  const originalFetch = globalThis.fetch;
  const original = Object.fromEntries(GEMINI_ENV.map((name) => [name, process.env[name]]));
  process.env.GEMINI_API_KEY = "test-only-gemini-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";
  process.env.GEMINI_TIMEOUT_MS = "120000";
  process.env.GEMINI_MAX_RETRIES = "0";
  process.env.GEMINI_EXPLICIT_CACHE = "false";

  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const payload = responses[requests.length - 1];
    if (!payload) throw new Error(`unexpected Gemini request #${requests.length}`);
    return new Response(JSON.stringify({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify(payload) }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

const ALL_VISIBLE = {
  face: "VISIBLE",
  upper_body: "VISIBLE",
  lower_body: "VISIBLE",
  footwear: "VISIBLE",
  id_card: "VISIBLE",
  hands: "VISIBLE",
};

const image = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

test("a photograph with no person costs one request, not two", async () => {
  const stub = withStubbedGemini([{
    subject_visible: false,
    attire_type: "UNKNOWN",
    image_quality: "RETAKE_RECOMMENDED",
    visible_regions: { ...ALL_VISIBLE, face: "NOT_VISIBLE" },
  }]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(image(), "image/jpeg", "FEMALE");

    assert.equal(stub.requests.length, 1, "there is nothing to run checkpoints against");
    assert.equal(result.overall_status, "UNASSESSED");
    assert.equal(result.unassessed_reason, "NO_PERSON_VISIBLE");
    assert.deepEqual(result.attire_check, []);
  } finally {
    stub.restore();
  }
});

test("an unidentifiable outfit is still reported on, minus the attire rows", async () => {
  const { checkpointSet, SECTION_KEYS } = await import("../src/checkpoints.js");
  const sections = checkpointSet("FEMALE", "UNKNOWN");
  const regions = { ...ALL_VISIBLE, lower_body: "NOT_VISIBLE" };
  const report = {
    subject_visible: true,
    image_quality: "RETAKE_RECOMMENDED",
    ai_summary: "The outfit could not be identified.",
    visible_regions: regions,
  };
  for (const key of SECTION_KEYS) {
    if (!sections[key].length) continue;
    report[key] = Object.fromEntries(sections[key].map((item) => [item.code, {
      status: "PASS",
      observation: "Visible and acceptable.",
      reason: "Meets the checkpoint.",
    }]));
  }

  const stub = withStubbedGemini([
    {
      subject_visible: true,
      attire_type: "UNKNOWN",
      image_quality: "RETAKE_RECOMMENDED",
      visible_regions: regions,
    },
    report,
  ]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(image(), "image/jpeg", "FEMALE");

    assert.equal(result.overall_status, "UNASSESSED", "no garment means no dress-code verdict");
    assert.equal(result.unassessed_reason, "ATTIRE_NOT_IDENTIFIED");
    assert.equal(result.visible_regions.lower_body, "NOT_VISIBLE");

    assert.deepEqual(
      result.general_idcard_check.map((item) => item.code),
      sections.general_idcard_check.map((item) => item.code),
    );
    assert.ok(result.grooming_check.length > 0);
    assert.ok(result.footwear_check.length > 0);
    assert.deepEqual(result.attire_check, [], "there is no family to score attire against");

    const reportSchema = stub.requests[1].generationConfig.responseJsonSchema;
    assert.equal("attire_check" in reportSchema.properties, false);
    assert.equal(reportSchema.required.includes("attire_check"), false);
  } finally {
    stub.restore();
  }
});

test("the report request follows whichever family was classified", async () => {
  const { checkpointSet, SECTION_KEYS } = await import("../src/checkpoints.js");
  const sections = checkpointSet("FEMALE", "KURTI_WITH_DUPATTA");
  const report = {
    subject_visible: true,
    image_quality: "ADEQUATE",
    ai_summary: "Assessed.",
    visible_regions: ALL_VISIBLE,
  };
  for (const key of SECTION_KEYS) {
    report[key] = Object.fromEntries(sections[key].map((item) => [item.code, {
      status: "PASS",
      observation: "Visible and acceptable.",
      reason: "Meets the checkpoint.",
    }]));
  }

  const stub = withStubbedGemini([
    {
      subject_visible: true,
      attire_type: "KURTI_WITH_DUPATTA",
      image_quality: "ADEQUATE",
      visible_regions: ALL_VISIBLE,
    },
    report,
  ]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(image(), "image/jpeg", "FEMALE");

    assert.equal(stub.requests.length, 2);
    assert.equal(result.attire_type, "KURTI_WITH_DUPATTA");
    assert.equal(result.overall_status, "COMPLIANT");
    assert.deepEqual(
      result.attire_check.map((item) => item.code),
      sections.attire_check.map((item) => item.code),
    );

    const reportSchema = stub.requests[1].generationConfig.responseJsonSchema;
    assert.deepEqual(
      Object.keys(reportSchema.properties.attire_check.properties),
      sections.attire_check.map((item) => item.code),
    );
  } finally {
    stub.restore();
  }
});

async function allPassReport(attireType, summary = "Assessed.") {
  const { checkpointSet, SECTION_KEYS } = await import("../src/checkpoints.js");
  const sections = checkpointSet("FEMALE", attireType);
  const report = { subject_visible: true, image_quality: "ADEQUATE", ai_summary: summary, visible_regions: ALL_VISIBLE };
  for (const key of SECTION_KEYS) {
    report[key] = Object.fromEntries(sections[key].map((item) => [item.code, {
      status: "PASS",
      observation: "Visible and acceptable.",
      reason: "Meets the checkpoint.",
    }]));
  }
  return report;
}

const classified = (attireType) => ({ subject_visible: true, attire_type: attireType, image_quality: "ADEQUATE", visible_regions: ALL_VISIBLE });

test("a woman in shirt and trousers fails Attire Type even when the model passed it", async () => {
  const stub = withStubbedGemini([
    classified("FORMAL"),
    await allPassReport("FORMAL", "The instructor wears a dark shirt with grey formal trousers and is compliant."),
  ]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(image(), "image/jpeg", "FEMALE");

    assert.equal(result.attire_type, "FORMAL", "the outfit is still identified");
    assert.equal(result.overall_status, "NON_COMPLIANT");
    const [attireType, ...others] = result.attire_check;
    assert.equal(attireType.code, "W_FORMAL_ATTIRE_TYPE");
    assert.equal(attireType.status, "FAIL");
    assert.equal(attireType.reason, "Shirt and trousers are not permitted for women; wear a saree or a kurti with dupatta.");
    assert.equal(attireType.observation, "Visible and acceptable.", "what the model saw is kept");
    assert.ok(others.length === 5 && others.every((row) => row.status === "PASS"), "the other formal rows keep their answers");
    assert.match(result.ai_summary, /^Shirt and trousers are not permitted for women; .* is compliant\.$/);
  } finally {
    stub.restore();
  }
});

test("saree, kurti and abaya are untouched by the shirt-and-trousers rule", async () => {
  const { evaluateImage, resolveWomenFormalAttire } = await import("../src/services/visionEngine.js");
  for (const family of ["SAREE", "KURTI_WITH_DUPATTA", "ABAYA"]) {
    const stub = withStubbedGemini([classified(family), await allPassReport(family)]);
    try {
      const result = await evaluateImage(image(), "image/jpeg", "FEMALE");
      assert.equal(result.overall_status, "COMPLIANT", family);
      assert.equal(result.ai_summary, "Assessed.", family);
    } finally {
      stub.restore();
    }
  }
  const failed = { attire_check: [{ code: "W_FORMAL_ATTIRE_TYPE", status: "FAIL", reason: "Jeans are not formal." }] };
  assert.equal(resolveWomenFormalAttire(failed, "FORMAL"), false);
  assert.equal(failed.attire_check[0].reason, "Jeans are not formal.");
  const men = { attire_check: [{ code: "M_SHIRT_TYPE", status: "PASS", reason: "Formal shirt." }] };
  assert.equal(resolveWomenFormalAttire(men, "FORMAL"), false);
  assert.equal(men.attire_check[0].status, "PASS");
});

test("the women's prompt and the row's standard and tip say shirt and trousers are not permitted", async () => {
  const { buildSystemPrompt, buildFemaleAttirePrompt } = await import("../src/prompts.js");
  const { checkpointSet, improvementTips } = await import("../src/checkpoints.js");
  const rule = checkpointSet("FEMALE", "FORMAL").attire_check.find((row) => row.code === "W_FORMAL_ATTIRE_TYPE").rule;
  assert.match(rule, /^Shirt and trousers are not permitted for women/);
  assert.match(rule, /always FAIL/);
  assert.match(buildSystemPrompt("FEMALE", "FORMAL"), /### SHIRT AND TROUSERS\nShirt and trousers are not permitted for women/);
  assert.match(buildFemaleAttirePrompt(), /identify\nit as FORMAL/);
  assert.match(buildFemaleAttirePrompt(), /- FORMAL: the outfit belongs to the western formal-wear family/);
  assert.doesNotMatch(buildSystemPrompt("MALE", "FORMAL"), /SHIRT AND TROUSERS/);
  const report = { overall_status: "NON_COMPLIANT", attire_check: [{ code: "W_FORMAL_ATTIRE_TYPE", status: "FAIL" }] };
  assert.match(improvementTips(report).join(" "), /Shirt and trousers are not permitted for women\. Wear a saree or a kurti with dupatta\./);
});

test("the classification step spends less reasoning budget than the report", async () => {
  const stub = withStubbedGemini([{
    subject_visible: false,
    attire_type: "UNKNOWN",
    image_quality: "RETAKE_RECOMMENDED",
    visible_regions: ALL_VISIBLE,
  }]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    await evaluateImage(image(), "image/jpeg", "FEMALE");

    const config = stub.requests[0].generationConfig;
    assert.ok(
      config.thinkingConfig.thinkingBudget < 4096,
      "one multiple-choice question does not need a full report's budget"
    );
    assert.ok(config.maxOutputTokens > config.thinkingConfig.thinkingBudget);
  } finally {
    stub.restore();
  }
});
