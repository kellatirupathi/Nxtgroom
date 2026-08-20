import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointSet, SECTION_KEYS } from "../src/checkpoints.js";

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

test("the reference set is whatever is on disk, not a fixed count", async () => {
  const { verifyVisionAssets } = await import("../src/services/visionEngine.js");
  // This asserted exactly eight images. Removing one that no longer had a
  // checkpoint — spectacles, once eyewear was dropped — crash-looped the API
  // on boot instead of sending one picture fewer.
  await assert.doesNotReject(() => verifyVisionAssets());

  const { readdir } = await import("node:fs/promises");
  const dir = new URL("../reference_images/", import.meta.url);
  const images = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".jpg"));
  assert.ok(images.length > 0, "the model needs something to compare against");

  // Filtering is by filename prefix, so a rename is what silently sends a
  // woman men's references. Every image must still start with a known prefix.
  const prefixes = ["accessories", "beard", "footwear", "hair", "id_card", "men", "women", "spectacles"];
  for (const name of images) {
    assert.ok(
      prefixes.some((prefix) => name.toLowerCase().startsWith(prefix)),
      `${name} starts with no prefix the gender filter recognises`
    );
  }
});

test("vision evaluation sends images and structured output to Gemini 3.7 Flash", async () => {
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
  process.env.GEMINI_API_KEY = "test-only-gemini-key";
  process.env.GEMINI_MODEL = "gemini-3.7-flash";
  process.env.GEMINI_TIMEOUT_MS = "120000";
  process.env.GEMINI_MAX_RETRIES = "0";
  globalThis.fetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(report) }] }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "MALE");
    assert.equal(result.overall_status, "COMPLIANT");
    assert.equal(captured.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(captured.options.headers["x-goog-api-key"], "test-only-gemini-key");
    assert.equal(captured.body.model, "gemini-3.7-flash");
    assert.equal(captured.body.store, false);
    assert.equal(captured.body.response_format.mime_type, "application/json");
    assert.equal(captured.body.generation_config.thinking_level, "medium");
    const images = captured.body.input.filter((part) => part.type === "image");
    assert.ok(images.length > 1, "reference images and the instructor image must be sent");
    assert.ok(images.every((part) => part.resolution === "high"));
    assert.ok(images.every((part) => part.data && part.mime_type === "image/jpeg"));
    assert.equal(captured.body.input.some((part) => part.type === "image_url"), false);
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
