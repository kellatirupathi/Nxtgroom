import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointSet, SECTION_KEYS } from "../src/checkpoints.js";
import { telemetrySnapshot } from "../src/services/telemetry.js";

/**
 * Mirrors the consistency rules applied to a parsed grooming report. Kept in
 * step with visionEngine.js by hand: the real function performs a network call
 * to Gemini, which cannot run in a unit test.
 */
function reconcile(report) {
  const checks = [
    ...report.general_idcard_check,
    ...report.grooming_check,
    ...report.attire_check,
    ...report.accessories_check,
    ...report.footwear_check,
  ];
  const assessed = checks.filter((item) => item.status !== "N/A");
  if (assessed.length === 0) {
    return {
      ...report,
      overall_status: "NON_COMPLIANT",
      image_quality: "RETAKE_RECOMMENDED",
      requires_human_review: true,
    };
  }
  const expected = checks.some((item) => item.status === "FAIL")
    ? "NON_COMPLIANT"
    : "COMPLIANT";
  if (report.overall_status !== expected) {
    throw new Error("The model returned an internally inconsistent evaluation");
  }
  return report;
}

function buildReport({ statuses, overall }) {
  const item = (status) => ({
    checkpoint_name: "check",
    observation: "observed",
    status,
    reason: "reason",
  });
  return {
    overall_status: overall,
    image_quality: "GOOD",
    ai_summary: "summary",
    requires_human_review: false,
    general_idcard_check: statuses.slice(0, 1).map(item),
    grooming_check: statuses.slice(1, 2).map(item),
    attire_check: statuses.slice(2, 3).map(item),
    accessories_check: statuses.slice(3, 4).map(item),
    footwear_check: statuses.slice(4).map(item),
  };
}

test("an unevaluable photo is flagged for review instead of failing", () => {
  // Reproduces a real production failure: a photo showing nothing assessable
  // came back with every checkpoint N/A and overall NON_COMPLIANT. The old
  // rule expected COMPLIANT when no check had failed, so the evaluation was
  // discarded, retried three times, and the attendance record was stuck in
  // error with no result for the user.
  const report = buildReport({
    statuses: ["N/A", "N/A", "N/A", "N/A", "N/A"],
    overall: "NON_COMPLIANT",
  });

  const result = reconcile(report);
  assert.equal(result.overall_status, "NON_COMPLIANT");
  assert.equal(result.image_quality, "RETAKE_RECOMMENDED");
  assert.equal(result.requires_human_review, true, "a human must look at it");
});

test("a failed checkpoint still requires a non-compliant verdict", () => {
  assert.throws(
    () => reconcile(buildReport({
      statuses: ["PASS", "FAIL", "PASS", "PASS", "PASS"],
      overall: "COMPLIANT",
    })),
    /internally inconsistent/,
    "a real contradiction must still be rejected",
  );
});

test("a clean evaluation passes through unchanged", () => {
  const report = buildReport({
    statuses: ["PASS", "PASS", "PASS", "PASS", "PASS"],
    overall: "COMPLIANT",
  });
  assert.equal(reconcile(report).overall_status, "COMPLIANT");
});

test("partial visibility is judged on what was actually assessed", () => {
  // Some checkpoints N/A is normal, so long as at least one was assessed.
  const report = buildReport({
    statuses: ["PASS", "N/A", "N/A", "PASS", "N/A"],
    overall: "COMPLIANT",
  });
  assert.equal(reconcile(report).overall_status, "COMPLIANT");
});

test("vision evaluation sends only the instructor image and structured output to Gemini 2.5 Flash-Lite", async () => {
  const originalFetch = globalThis.fetch;
  const originalGemini = {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
    timeout: process.env.GEMINI_TIMEOUT_MS,
    retries: process.env.GEMINI_MAX_RETRIES,
  };
  const sections = checkpointSet("MALE", "FORMAL");
  const report = {
    subject_visible: true,
    image_quality: "ADEQUATE",
    ai_summary: "All visible requirements pass.",
    visible_regions: {
      face: "VISIBLE",
      upper_body: "VISIBLE",
      lower_body: "VISIBLE",
      footwear: "VISIBLE",
      id_card: "VISIBLE",
      hands: "VISIBLE",
    },
  };
  for (const key of SECTION_KEYS) {
    report[key] = Object.fromEntries(sections[key].map((item) => [item.code, {
      status: "PASS",
      observation: "Visible and acceptable.",
      reason: "Meets the checkpoint.",
    }]));
  }

  let captured;
  const metricsBefore = telemetrySnapshot().counters;
  process.env.GEMINI_API_KEY = "test-only-gemini-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";
  process.env.GEMINI_TIMEOUT_MS = "120000";
  process.env.GEMINI_MAX_RETRIES = "0";
  globalThis.fetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify(report) }] },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 5000,
        candidatesTokenCount: 500,
        totalTokenCount: 5500,
        cachedContentTokenCount: 4096,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "MALE");
    assert.equal(result.overall_status, "COMPLIANT");
    assert.equal(
      captured.url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
    );
    assert.equal(captured.options.headers["x-goog-api-key"], "test-only-gemini-key");
    assert.equal(typeof captured.body.systemInstruction.parts[0].text, "string");
    assert.equal(captured.body.generationConfig.responseMimeType, "application/json");
    assert.equal(captured.body.generationConfig.responseJsonSchema.additionalProperties, false);
    assert.equal(captured.body.generationConfig.maxOutputTokens, 6000);
    assert.equal(captured.body.generationConfig.temperature, 0);
    assert.equal(captured.body.generationConfig.thinkingConfig.thinkingBudget, 0);
    assert.equal(captured.body.generationConfig.mediaResolution, "MEDIA_RESOLUTION_HIGH");
    assert.equal(captured.body.contents.length, 1);
    assert.equal(captured.body.contents[0].role, "user");
    const images = captured.body.contents[0].parts.filter((part) => part.inlineData);
    assert.equal(images.length, 1, "only the changing instructor image must be sent");
    assert.equal(images[0].inlineData.mimeType, "image/jpeg");
    assert.equal(images[0].inlineData.data, "/9j/4A==", "the single image must be the instructor photograph");
    const inputText = captured.body.contents[0].parts
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text)
      .join(" ");
    assert.match(inputText, /written NxtWave Grooming Standard/i);
    assert.doesNotMatch(inputText, /reference image/i);
    const metricsAfter = telemetrySnapshot().counters;
    assert.equal(
      metricsAfter.gemini_input_tokens_total - (metricsBefore.gemini_input_tokens_total || 0),
      5000,
    );
    assert.equal(
      metricsAfter.gemini_cached_input_tokens_total
        - (metricsBefore.gemini_cached_input_tokens_total || 0),
      4096,
    );
    assert.equal(
      metricsAfter.gemini_prompt_cache_hits_total
        - (metricsBefore.gemini_prompt_cache_hits_total || 0),
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      GEMINI_API_KEY: originalGemini.apiKey,
      GEMINI_MODEL: originalGemini.model,
      GEMINI_TIMEOUT_MS: originalGemini.timeout,
      GEMINI_MAX_RETRIES: originalGemini.retries,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("female attire classification and its matching report use one image request", async () => {
  const originalFetch = globalThis.fetch;
  const originalGemini = {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
    timeout: process.env.GEMINI_TIMEOUT_MS,
    retries: process.env.GEMINI_MAX_RETRIES,
  };
  const sections = checkpointSet("FEMALE", "SAREE");
  const report = {
    attire_type: "SAREE",
    subject_visible: true,
    image_quality: "ADEQUATE",
    ai_summary: "The visible saree and other assessed requirements pass.",
    visible_regions: {
      face: "VISIBLE",
      upper_body: "VISIBLE",
      lower_body: "VISIBLE",
      footwear: "VISIBLE",
      id_card: "VISIBLE",
      hands: "VISIBLE",
    },
  };
  for (const key of SECTION_KEYS) {
    report[key] = Object.fromEntries(sections[key].map((item) => [item.code, {
      status: "PASS",
      observation: "Visible and acceptable.",
      reason: "Meets the checkpoint.",
    }]));
  }

  let requestCount = 0;
  let captured;
  process.env.GEMINI_API_KEY = "test-only-gemini-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";
  process.env.GEMINI_TIMEOUT_MS = "120000";
  process.env.GEMINI_MAX_RETRIES = "0";
  globalThis.fetch = async (url, options) => {
    requestCount += 1;
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify({ evaluation: report }) }] },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 7000,
        candidatesTokenCount: 500,
        totalTokenCount: 7500,
        cachedContentTokenCount: 4096,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "FEMALE");

    assert.equal(requestCount, 1, "the female image must not be sent to a separate classifier");
    assert.equal(result.overall_status, "COMPLIANT");
    assert.equal(result.attire_type, "SAREE");
    assert.deepEqual(
      result.attire_check.map((item) => item.code),
      sections.attire_check.map((item) => item.code),
      "only the selected saree rows should reach the stored report",
    );
    assert.equal(captured.body.generationConfig.responseJsonSchema.type, "object");
    assert.equal(captured.body.generationConfig.responseJsonSchema.properties.evaluation.anyOf.length, 4);
    const images = captured.body.contents[0].parts.filter((part) => part.inlineData);
    assert.equal(images.length, 1);
    assert.equal(images[0].inlineData.data, "/9j/4A==");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      GEMINI_API_KEY: originalGemini.apiKey,
      GEMINI_MODEL: originalGemini.model,
      GEMINI_TIMEOUT_MS: originalGemini.timeout,
      GEMINI_MAX_RETRIES: originalGemini.retries,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
