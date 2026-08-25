import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { runtimeConfig } from "../config/env.js";
import { incrementMetric, observeDuration } from "./telemetry.js";
import { buildFemaleSystemPrompt, buildSystemPrompt } from "../prompts.js";
import { checkpointSet, INFORMATIONAL_CODES, SECTION_KEYS } from "../checkpoints.js";

const GEMINI_API_ORIGIN = "https://generativelanguage.googleapis.com";
const FEMALE_ATTIRE_TYPES = ["SAREE", "KURTI_WITH_DUPATTA", "FORMAL", "UNKNOWN"];

const VISIBILITY = z.enum(["VISIBLE", "PARTIAL", "NOT_VISIBLE"]);

/**
 * One checkpoint's verdict.
 *
 * The code and the display name are deliberately absent: they come from the
 * checkpoint table, not from the model, so they cannot be misspelled, renamed
 * or invented. The model supplies only the judgement.
 */
const Entry = z.object({
  status: z.enum(["PASS", "FAIL", "N/A"]),
  observation: z.string(),
  reason: z.string(),
});

const ENTRY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["PASS", "FAIL", "N/A"] },
    observation: { type: "string" },
    reason: { type: "string" },
  },
  required: ["status", "observation", "reason"],
};

function createGeminiError(message, code, { retryable = false } = {}) {
  const error = new Error(message);
  error.name = code;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function geminiHttpError(status, providerMessage = "") {
  const safeMessage = String(providerMessage).replace(/\s+/g, " ").slice(0, 300);
  if (status === 429) {
    return createGeminiError(
      `Gemini rate limit exceeded${safeMessage ? `: ${safeMessage}` : ""}`,
      "RATE_LIMIT_EXCEEDED",
      { retryable: true }
    );
  }
  if (status === 401 || status === 403) {
    return createGeminiError("Gemini authentication failed", "GEMINI_AUTH_ERROR");
  }
  if (status === 408) {
    return createGeminiError("Gemini request timed out", "GEMINI_TIMEOUT", { retryable: true });
  }
  if (status >= 500) {
    return createGeminiError(
      `Gemini service error (${status})${safeMessage ? `: ${safeMessage}` : ""}`,
      "GEMINI_SERVER_ERROR",
      { retryable: true }
    );
  }
  return createGeminiError(
    `Gemini request failed (${status})${safeMessage ? `: ${safeMessage}` : ""}`,
    "GEMINI_REQUEST_ERROR"
  );
}

function retryAfterMilliseconds(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 60000);
  }
  return Math.min(1000 * (2 ** attempt), 10000);
}

function extractGeminiText(responseBody) {
  return (responseBody?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

/** Records provider-reported usage without logging prompts, images or people. */
function recordGeminiUsage(responseBody) {
  const usage = responseBody?.usageMetadata || {};
  const inputTokens = Number(usage.promptTokenCount || 0);
  const outputTokens = Number(usage.candidatesTokenCount || 0);
  const cachedTokens = Number(usage.cachedContentTokenCount || 0);
  if (Number.isFinite(inputTokens) && inputTokens > 0) {
    incrementMetric("gemini_input_tokens_total", inputTokens);
  }
  if (Number.isFinite(outputTokens) && outputTokens > 0) {
    incrementMetric("gemini_output_tokens_total", outputTokens);
  }
  if (Number.isFinite(cachedTokens) && cachedTokens > 0) {
    incrementMetric("gemini_cached_input_tokens_total", cachedTokens);
  }
  // Keep the stable system instruction and schema before the changing image
  // content so Gemini can reuse an eligible exact-prefix cache.
  incrementMetric("gemini_prompt_cache_requests_total");
  incrementMetric(cachedTokens > 0
    ? "gemini_prompt_cache_hits_total"
    : "gemini_prompt_cache_misses_total");
}

function geminiPart(part) {
  if (part?.type === "input_text") return { text: part.text };
  if (part?.type === "input_image") {
    return {
      inlineData: {
        mimeType: part.mimeType,
        data: part.data,
      },
    };
  }
  throw createGeminiError("Unsupported Gemini input part", "GEMINI_REQUEST_ERROR");
}

async function requestGeminiStructured({
  systemInstruction,
  input,
  jsonSchema,
  validator,
  maxOutputTokens,
}) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw createGeminiError("GEMINI_API_KEY is not configured", "GEMINI_AUTH_ERROR");

  const config = runtimeConfig();
  const endpoint = `${GEMINI_API_ORIGIN}/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`;
  const requestBody = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [{
      role: "user",
      parts: input.map(geminiPart),
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: jsonSchema,
      maxOutputTokens,
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 },
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
    },
  };

  for (let attempt = 0; attempt <= config.geminiMaxRetries; attempt += 1) {
    const requestStartedAt = Date.now();
    incrementMetric("gemini_requests_total");
    if (attempt > 0) incrementMetric("gemini_retries_total");
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(config.geminiTimeoutMs),
      });
      observeDuration("gemini_request_latency", Date.now() - requestStartedAt);
    } catch (cause) {
      observeDuration("gemini_request_latency", Date.now() - requestStartedAt);
      incrementMetric("gemini_request_failures_total");
      const timedOut = cause?.name === "TimeoutError" || cause?.name === "AbortError";
      const error = createGeminiError(
        timedOut ? "Gemini request timed out" : "Gemini request could not reach the service",
        timedOut ? "GEMINI_TIMEOUT" : "GEMINI_NETWORK_ERROR",
        { retryable: true }
      );
      if (attempt === config.geminiMaxRetries) throw error;
      await delay(Math.min(1000 * (2 ** attempt), 10000));
      continue;
    }

    const bodyText = await response.text();
    let body;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      throw createGeminiError("Gemini returned an unreadable response", "GEMINI_INVALID_RESPONSE");
    }

    if (!response.ok) {
      incrementMetric("gemini_request_failures_total");
      const error = geminiHttpError(response.status, body?.error?.message);
      if (!error.retryable || attempt === config.geminiMaxRetries) throw error;
      await delay(retryAfterMilliseconds(response, attempt));
      continue;
    }
    recordGeminiUsage(body);
    const finishReason = body?.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== "STOP") {
      throw createGeminiError(
        `Gemini did not complete the evaluation (finish reason: ${finishReason})`,
        "GEMINI_INCOMPLETE_RESPONSE"
      );
    }

    const text = extractGeminiText(body);
    if (!text) {
      const blockReason = body?.promptFeedback?.blockReason;
      throw createGeminiError(
        blockReason
          ? `Gemini blocked the evaluation (${blockReason})`
          : "Gemini returned no structured evaluation",
        blockReason ? "GEMINI_BLOCKED_RESPONSE" : "GEMINI_INVALID_RESPONSE"
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw createGeminiError("Gemini returned invalid structured JSON", "GEMINI_INVALID_RESPONSE");
    }
    incrementMetric("gemini_request_success_total");
    return validator.parse(parsed);
  }

  throw createGeminiError("Gemini evaluation failed", "GEMINI_REQUEST_ERROR");
}

/**
 * A schema whose keys are exactly this instructor's checkpoint codes.
 *
 * Structured outputs require every object key to be present, so keying by code
 * rather than returning an array makes four whole classes of bad response
 * impossible rather than merely detectable: a checkpoint cannot be omitted,
 * duplicated, returned under a foreign code, or returned out of order. The
 * previous array schema could express all four, and did.
 */
function buildReportSchema(sections, { attireType = null } = {}) {
  const shape = {
    // Asked directly rather than inferred from the checkpoints. "Nothing was
    // examined" and "nothing was wrong" both produce a report with no
    // failures, and only this tells them apart.
    subject_visible: z.boolean(),
    image_quality: z.enum(["ADEQUATE", "RETAKE_RECOMMENDED"]),
    ai_summary: z.string(),
    visible_regions: z.object({
      face: VISIBILITY,
      upper_body: VISIBILITY,
      lower_body: VISIBILITY,
      footwear: VISIBILITY,
      id_card: VISIBILITY,
      hands: VISIBILITY,
    }),
  };
  if (attireType) shape.attire_type = z.literal(attireType);
  for (const key of SECTION_KEYS) {
    shape[key] = z.object(
      Object.fromEntries(sections[key].map((item) => [item.code, Entry]))
    );
  }
  return z.object(shape);
}

function buildReportJsonSchema(sections, { attireType = null } = {}) {
  const properties = {
    subject_visible: { type: "boolean" },
    image_quality: { type: "string", enum: ["ADEQUATE", "RETAKE_RECOMMENDED"] },
    ai_summary: { type: "string" },
    visible_regions: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries([
        "face", "upper_body", "lower_body", "footwear", "id_card", "hands",
      ].map((key) => [key, { type: "string", enum: ["VISIBLE", "PARTIAL", "NOT_VISIBLE"] }])),
      required: ["face", "upper_body", "lower_body", "footwear", "id_card", "hands"],
    },
  };
  if (attireType) properties.attire_type = { type: "string", enum: [attireType] };
  for (const key of SECTION_KEYS) {
    properties[key] = {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(sections[key].map((item) => [item.code, ENTRY_JSON_SCHEMA])),
      required: sections[key].map((item) => item.code),
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: [
      "subject_visible",
      "image_quality",
      "ai_summary",
      "visible_regions",
      ...(attireType ? ["attire_type"] : []),
      ...SECTION_KEYS,
    ],
  };
}

/**
 * A strict nested union lets one response choose one female attire family
 * without returning the unused families' checkpoint rows. Structured Outputs
 * permits anyOf below the root object, so the outer evaluation key keeps the
 * schema valid while each branch remains exact and independently validated.
 */
function buildFemaleResponseSchema() {
  return z.object({
    evaluation: z.union(FEMALE_ATTIRE_TYPES.map((attireType) => (
      buildReportSchema(checkpointSet("FEMALE", attireType), { attireType })
    ))),
  });
}

function buildFemaleResponseJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      evaluation: {
        anyOf: FEMALE_ATTIRE_TYPES.map((attireType) => (
          buildReportJsonSchema(checkpointSet("FEMALE", attireType), { attireType })
        )),
      },
    },
    required: ["evaluation"],
  };
}

/** Rebuilds the ordered rows the report renders, from the checkpoint table. */
function toOrderedRows(sections, parsed) {
  const result = {};
  for (const key of SECTION_KEYS) {
    result[key] = sections[key].map((item) => {
      const entry = parsed[key][item.code];
      return {
        code: item.code,
        checkpoint_name: item.name,
        status: entry.status,
        observation: String(entry.observation || "").slice(0, 1000) || "Not stated.",
        reason: String(entry.reason || "").slice(0, 1000) || "Not stated.",
      };
    });
  }
  return result;
}

/**
 * Settles an ID card row that abstained while describing a violation.
 *
 * The checkpoint asks one thing — is a card being worn — so the photograph can
 * only fail to answer it when the chest is not shown. Asked directly, the model
 * still returned N/A for a clearly visible chest with no card on it, giving as
 * its reason "the upper body is visible, but no ID card is present": the FAIL
 * condition, stated in full, filed as an abstention. Every rewording of the
 * instruction left some version of that contradiction, so the two visibility
 * regions decide it here instead of the wording.
 *
 * Only this direction is corrected. A PASS is the model reporting a card it can
 * see, which no region flag contradicts, and turning an abstention into a FAIL
 * needs both regions to agree that the chest is shown and the card is not.
 */
export function resolveIdCardAbstention(rows, visibleRegions) {
  const row = (rows.general_idcard_check || []).find((item) => item.code === "ID_PRESENT");
  if (!row || row.status !== "N/A") return rows;
  if (visibleRegions?.upper_body !== "VISIBLE") return rows;
  if (visibleRegions?.id_card !== "NOT_VISIBLE") return rows;
  row.status = "FAIL";
  row.reason = "The upper body is visible and no ID card is being worn.";
  return rows;
}

/**
 * Enforces the small set of men's visibility rules whose result is otherwise
 * easy for a vision model to contradict in its own prose.
 *
 * Tuck and belt are required capture checks: an image that does not show them
 * has not demonstrated compliance, so their checkpoint contract deliberately
 * treats an abstention as a failure. Rings and chains work in the opposite
 * direction: when the relevant area is visible and the model explicitly says
 * the accessory is absent, absence is a PASS rather than N/A.
 */
export function resolveMaleAttireVisibility(rows, visibleRegions) {
  const find = (section, code) => (rows?.[section] || []).find((item) => item.code === code);

  // Tuck is a separate checkpoint. Correct only the narrow category error in
  // which an untucked waist is used to fail Shirt Fit; genuine fit violations
  // such as pulling, tightness, looseness and bunching remain failures.
  const shirtFit = find("attire_check", "M_SHIRT_FIT");
  if (shirtFit?.status === "FAIL") {
    const text = `${shirtFit.observation || ""} ${shirtFit.reason || ""}`.toLowerCase();
    const mentionsTuck = /\b(?:tuck(?:ed|ing)?|untucked|waist(?:band)?|shirt\s+(?:hem|tail))\b/i.test(text);
    const mentionsFitViolation = /\b(?:pull(?:ing|s|ed)?|tight(?:ness)?|bunch(?:ing|ed)?|baggy|loose(?:ness)?|ill[-\s]?fitt?ing|poor\s+fit)\b/i.test(text);
    if (mentionsTuck && !mentionsFitViolation) {
      shirtFit.status = "PASS";
      shirtFit.observation = "No shirt-fit violation is identified; shirt tuck is assessed separately.";
      shirtFit.reason = "Tucking is evaluated only in the Shirt Collar / Tuck checkpoint.";
    }
  }

  const tuck = find("attire_check", "M_SHIRT_COLLAR_TUCK");
  if (tuck?.status === "N/A") {
    tuck.status = "FAIL";
    tuck.reason = "The submitted photograph does not show the required shirt tuck clearly enough to verify compliance.";
  }

  const belt = find("attire_check", "M_BELT");
  if (belt?.status === "N/A") {
    belt.status = "FAIL";
    belt.reason = "The submitted photograph does not show the required belt clearly enough to verify compliance.";
  }

  const explicitlyAbsent = (row, itemPattern) => {
    const text = `${row?.observation || ""} ${row?.reason || ""}`.toLowerCase();
    if (/\b(?:cropped|obscured|covered|blurred|unclear|too\s+(?:small|distant)|cannot\s+assess|can't\s+assess|unable\s+to\s+(?:assess|identify|tell))\b/i.test(text)) {
      return false;
    }
    return new RegExp(`(?:no|without)\\s+(?:visible\\s+)?(?:${itemPattern})\\w*\\b|(?:${itemPattern})\\w*[^.]{0,35}\\b(?:not\\s+(?:visible|present|seen|noted)|absent)\\b`, "i").test(text);
  };

  const rings = find("accessories_check", "M_RINGS");
  if (rings?.status === "N/A"
      && visibleRegions?.hands === "VISIBLE"
      && explicitlyAbsent(rings, "ring")) {
    rings.status = "PASS";
    rings.reason = "The hands are clearly visible and no rings are present, which complies with the standard.";
  }

  const chain = find("accessories_check", "M_CHAIN");
  if (chain?.status === "N/A"
      && visibleRegions?.upper_body === "VISIBLE"
      && explicitlyAbsent(chain, "chain|necklace|pendant")) {
    chain.status = "PASS";
    chain.reason = "The neck and collar area are visible and no chain, necklace or pendant is present, which complies with the standard.";
  }

  return rows;
}

/**
 * The compliance verdict, computed from the checkpoints rather than asked for.
 *
 * The model used to be asked for overall_status and then checked against the
 * rows; a disagreement threw away an otherwise sound evaluation and left the
 * attendance record in error. The rule has one line, so there is nothing to
 * ask: any FAIL means non-compliant, and N/A never does.
 */
export function deriveVerdict(rows, { imageQuality } = {}) {
  // Informational rows are excluded outright rather than trusted to come back
  // as PASS. A watch is optional, so a model that returns FAIL for one must
  // not be able to mark somebody non-compliant for wearing it.
  const checks = SECTION_KEYS
    .flatMap((key) => rows[key] || [])
    .filter((item) => !INFORMATIONAL_CODES.has(item.code));
  const anyFail = checks.some((item) => item.status === "FAIL");
  // A photo showing nothing assessable comes back entirely N/A. That is not a
  // verdict about the instructor, so it asks for a retake instead of one.
  const nothingAssessed = checks.length > 0
    && checks.every((item) => item.status === "N/A");

  return {
    // No assessed checkpoint is not evidence of compliance. Treat an empty
    // or all-N/A result as unassessed so a ceiling, group shot, or occluded
    // person can never receive a clean verdict merely because nothing failed.
    overall_status: nothingAssessed || checks.length === 0
      ? "UNASSESSED"
      : anyFail ? "NON_COMPLIANT" : "COMPLIANT",
    image_quality: nothingAssessed ? "RETAKE_RECOMMENDED" : (imageQuality || "ADEQUATE"),
  };
}

function instructorImagePart(imageBuffer, mimeType) {
  return {
    type: "input_image",
    mimeType,
    data: imageBuffer.toString("base64"),
  };
}

/**
 * A result that makes no compliance claim.
 *
 * Used wherever the checkpoints could not meaningfully be applied. The five
 * sections come back empty on purpose: twenty rows of N/A tell a reader
 * nothing they cannot already see from one sentence, and rendering them
 * implies the checks ran and found nothing wrong.
 *
 * overall_status is UNASSESSED rather than COMPLIANT. A report with no
 * failures and a report where nothing was examined are not the same thing, and
 * calling the second one compliant is how a photograph of a ceiling passed.
 */
export function unassessedEvaluation(reason, summary, { imageQuality = "ADEQUATE" } = {}) {
  return {
    overall_status: "UNASSESSED",
    attire_type: "UNKNOWN",
    image_quality: imageQuality,
    ai_summary: summary,
    general_idcard_check: [],
    grooming_check: [],
    attire_check: [],
    accessories_check: [],
    footwear_check: [],
    visible_regions: null,
    unassessed_reason: reason,
  };
}

/**
 * The evaluation returned when no gender is on the instructor record.
 *
 * Every dress-code rule below the ID card differs by gender, so there is no
 * honest verdict to give: assessing against both — which is what happened
 * before — measured men against saree standards and produced failures for
 * rules that never applied to them.
 */
export function unknownGenderEvaluation() {
  return unassessedEvaluation(
    "GENDER_NOT_CONFIGURED",
    "This instructor has no gender recorded, so the applicable dress code could not be determined and no appearance assessment was made. Set the gender on the instructor record; the next check-in will be assessed normally."
  );
}

export async function evaluateImage(imageBuffer, mimeType, gender = null) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error("Instructor image is empty or invalid");
  }
  const normalizedGender = gender?.toUpperCase();
  if (normalizedGender !== "MALE" && normalizedGender !== "FEMALE") {
    return unknownGenderEvaluation();
  }

  const content = [{
    type: "input_text",
    text: "Assess the instructor in the following image against every applicable written NxtWave Grooming Standard in the instructions.",
  }];
  content.push(instructorImagePart(imageBuffer, mimeType));

  let attireType = "FORMAL";
  let parsed;
  if (normalizedGender === "FEMALE") {
    const response = await requestGeminiStructured({
      systemInstruction: buildFemaleSystemPrompt(),
      input: content,
      jsonSchema: buildFemaleResponseJsonSchema(),
      validator: buildFemaleResponseSchema(),
      maxOutputTokens: 6000,
    });
    parsed = response.evaluation;
    attireType = parsed.attire_type;
  } else {
    const maleSections = checkpointSet("MALE", attireType);
    parsed = await requestGeminiStructured({
      systemInstruction: buildSystemPrompt("MALE", attireType),
      input: content,
      jsonSchema: buildReportJsonSchema(maleSections),
      validator: buildReportSchema(maleSections),
      maxOutputTokens: 6000,
    });
  }
  const sections = checkpointSet(normalizedGender, attireType);

  // Nothing to tabulate when the photograph does not show the person. The
  // checkpoints are dropped rather than returned as twenty N/A rows, and no
  // verdict is recorded against the instructor for a picture of a wall.
  if (parsed.subject_visible === false) {
    incrementMetric("evaluations_unassessed_total");
    return unassessedEvaluation(
      "NO_PERSON_VISIBLE",
      "The photograph does not show the instructor, so no appearance assessment could be made. Retake it as a clear, full-length photo of the person checking in.",
      { imageQuality: "RETAKE_RECOMMENDED" }
    );
  }

  const rows = toOrderedRows(sections, parsed);
  resolveIdCardAbstention(rows, parsed.visible_regions);
  if (normalizedGender === "MALE") {
    resolveMaleAttireVisibility(rows, parsed.visible_regions);
  }
  const verdict = attireType === "UNKNOWN"
    ? { overall_status: "UNASSESSED", image_quality: "RETAKE_RECOMMENDED" }
    : deriveVerdict(rows, { imageQuality: parsed.image_quality });
  if (verdict.overall_status === "UNASSESSED") incrementMetric("evaluations_unassessed_total");

  return {
    ...verdict,
    attire_type: attireType,
    ai_summary: String(parsed.ai_summary || "").slice(0, 1500),
    visible_regions: parsed.visible_regions,
    ...(attireType === "UNKNOWN" ? { unassessed_reason: "ATTIRE_NOT_IDENTIFIED" } : {}),
    ...rows,
  };
}
