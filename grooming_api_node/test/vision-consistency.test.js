import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointSet, SECTION_KEYS } from "../src/checkpoints.js";
import { telemetrySnapshot } from "../src/services/telemetry.js";

/**
 * Mirrors the consistency rules applied to a parsed grooming report. Kept in
 * step with visionEngine.js by hand: the real function performs a network call
 * to OpenAI, which cannot run in a unit test.
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

test("vision evaluation sends only the instructor image and structured output to GPT-4o mini", async () => {
  const originalFetch = globalThis.fetch;
  const originalOpenAI = {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
    timeout: process.env.OPENAI_TIMEOUT_MS,
    retries: process.env.OPENAI_MAX_RETRIES,
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
  process.env.OPENAI_API_KEY = "test-only-openai-key";
  process.env.OPENAI_MODEL = "gpt-4o-mini-2024-07-18";
  process.env.OPENAI_TIMEOUT_MS = "120000";
  process.env.OPENAI_MAX_RETRIES = "0";
  globalThis.fetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      status: "completed",
      usage: {
        input_tokens: 5000,
        output_tokens: 500,
        total_tokens: 5500,
        input_tokens_details: { cached_tokens: 4096 },
      },
      output: [{
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(report), annotations: [] }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "MALE");
    assert.equal(result.overall_status, "COMPLIANT");
    assert.equal(captured.url, "https://api.openai.com/v1/responses");
    assert.equal(captured.options.headers.authorization, "Bearer test-only-openai-key");
    assert.equal(captured.body.model, "gpt-4o-mini-2024-07-18");
    assert.equal(captured.body.store, false);
    assert.equal(typeof captured.body.instructions, "string");
    assert.equal(captured.body.text.format.type, "json_schema");
    assert.equal(captured.body.text.format.name, "grooming_evaluation");
    assert.equal(captured.body.text.format.strict, true);
    assert.equal(captured.body.text.format.schema.additionalProperties, false);
    assert.equal(captured.body.max_output_tokens, 6000);
    assert.equal(captured.body.temperature, 0);
    assert.equal(captured.body.prompt_cache_key, "grooming-evaluation:v2:male:formal");
    assert.equal("prompt_cache_retention" in captured.body, false);
    assert.equal(captured.body.input.length, 1);
    assert.equal(captured.body.input[0].role, "user");
    const images = captured.body.input[0].content.filter((part) => part.type === "input_image");
    assert.equal(images.length, 1, "only the changing instructor image must be sent");
    assert.ok(images.every((part) => part.detail === "high"));
    assert.ok(images.every((part) => part.image_url.startsWith("data:image/jpeg;base64,")));
    assert.equal(
      images[0].image_url,
      "data:image/jpeg;base64,/9j/4A==",
      "the single image must be the instructor photograph",
    );
    const inputText = captured.body.input[0].content
      .filter((part) => part.type === "input_text")
      .map((part) => part.text)
      .join(" ");
    assert.match(inputText, /written NxtWave Grooming Standard/i);
    assert.doesNotMatch(inputText, /reference image/i);
    const metricsAfter = telemetrySnapshot().counters;
    assert.equal(
      metricsAfter.openai_input_tokens_total - (metricsBefore.openai_input_tokens_total || 0),
      5000,
    );
    assert.equal(
      metricsAfter.openai_cached_input_tokens_total
        - (metricsBefore.openai_cached_input_tokens_total || 0),
      4096,
    );
    assert.equal(
      metricsAfter.openai_prompt_cache_hits_total
        - (metricsBefore.openai_prompt_cache_hits_total || 0),
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      OPENAI_API_KEY: originalOpenAI.apiKey,
      OPENAI_MODEL: originalOpenAI.model,
      OPENAI_TIMEOUT_MS: originalOpenAI.timeout,
      OPENAI_MAX_RETRIES: originalOpenAI.retries,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
