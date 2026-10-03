import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { runtimeConfig } from "../config/env.js";
import { incrementMetric, observeDuration } from "./telemetry.js";
import { buildFemaleAttirePrompt, buildMaleReportPrompt, buildSystemPrompt } from "../prompts.js";
import { checkpointSet, INFORMATIONAL_CODES, MALE_ATTIRE_TYPES, maleCombinedSet, SECTION_KEYS } from "../checkpoints.js";
import {
  applyDetailFindings,
  buildCloseUps,
  CLOSE_UP_INSTRUCTIONS,
  CLOSE_UP_JSON_SCHEMA,
  CloseUpAnswer,
  DETAIL_CHECK_VERSION,
  evidenceBoxes,
  findingsFromCloseUp,
} from "./detailCheck.js";
import { applyBlazer, BLAZER_JSON_SCHEMA, blazerWorn } from "./blazer.js";

const GEMINI_API_ORIGIN = "https://generativelanguage.googleapis.com";
const FEMALE_ATTIRE_TYPES = ["SAREE", "KURTI_WITH_DUPATTA", "FORMAL", "ABAYA", "UNKNOWN"];
const DEFAULT_THINKING_BUDGET = 4096;
const CLASSIFICATION_THINKING_BUDGET = 1024;
const CACHE_RENEWAL_SAFETY_SECONDS = 300;
const CACHE_FAILURE_BACKOFF_MS = 60_000;
const CACHE_FAILURE_BACKOFF_JITTER_MS = 30_000;

const geminiCacheRegistry = new Map();

const VISIBILITY = z.enum(["VISIBLE", "PARTIAL", "NOT_VISIBLE"]);

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

function recordGeminiUsage(responseBody) {
  const usage = responseBody?.usageMetadata || {};
  const inputTokens = Number(usage.promptTokenCount || 0);
  const outputTokens = Number(usage.candidatesTokenCount || 0);
  if (Number.isFinite(outputTokens) && outputTokens > 0) {
    observeDuration("gemini_output_tokens", outputTokens);
  }
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cacheRegistryKey({ apiKey, model, namespace, systemInstruction }) {
  return [sha256(apiKey).slice(0, 16), model, namespace, sha256(systemInstruction)].join(":");
}

function cachedContentModel(model) {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function safeProviderMessage(body) {
  return String(body?.error?.message || "")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

async function ensureGeminiPromptCache({ apiKey, config, namespace, systemInstruction }) {
  if (!config.geminiExplicitCache) return null;

  const registryKey = cacheRegistryKey({
    apiKey,
    model: config.geminiModel,
    namespace,
    systemInstruction,
  });
  const now = Date.now();
  const existing = geminiCacheRegistry.get(registryKey);
  if (existing && existing.expiresAt > now) {
    return existing.namePromise.then((name) => (name ? { name, registryKey } : null));
  }

  const reuseSeconds = Math.max(
    config.geminiCacheTtlSeconds - CACHE_RENEWAL_SAFETY_SECONDS,
    Math.floor(config.geminiCacheTtlSeconds / 2),
  );
  const entry = {
    expiresAt: now + reuseSeconds * 1000,
    namePromise: Promise.resolve(null),
  };

  entry.namePromise = (async () => {
    incrementMetric("gemini_explicit_cache_create_attempts_total");
    try {
      const response = await fetch(`${GEMINI_API_ORIGIN}/v1beta/cachedContents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model: cachedContentModel(config.geminiModel),
          displayName: `nxtgroom-${namespace}-${sha256(systemInstruction).slice(0, 12)}`.slice(0, 128),
          systemInstruction: { parts: [{ text: systemInstruction }] },
          ttl: `${config.geminiCacheTtlSeconds}s`,
        }),
        signal: AbortSignal.timeout(Math.min(config.geminiTimeoutMs, 30_000)),
      });
      const bodyText = await response.text();
      let body = {};
      try {
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch {
      }
      const name = typeof body?.name === "string" ? body.name : null;
      if (!response.ok || !name) {
        incrementMetric("gemini_explicit_cache_create_failures_total");
        entry.expiresAt = Date.now() + CACHE_FAILURE_BACKOFF_MS
          + Math.floor(Math.random() * CACHE_FAILURE_BACKOFF_JITTER_MS);
        console.warn(
          `Gemini explicit prompt cache unavailable for ${namespace} (${response.status}`
          + `${safeProviderMessage(body) ? `: ${safeProviderMessage(body)}` : ""}); using uncached evaluation.`
        );
        return null;
      }
      incrementMetric("gemini_explicit_cache_create_successes_total");
      return name;
    } catch (error) {
      incrementMetric("gemini_explicit_cache_create_failures_total");
      entry.expiresAt = Date.now() + CACHE_FAILURE_BACKOFF_MS
        + Math.floor(Math.random() * CACHE_FAILURE_BACKOFF_JITTER_MS);
      console.warn(
        `Gemini explicit prompt cache unavailable for ${namespace} (${error?.name || "request error"}); using uncached evaluation.`
      );
      return null;
    }
  })();

  geminiCacheRegistry.set(registryKey, entry);
  const name = await entry.namePromise;
  return name ? { name, registryKey } : null;
}

function invalidateGeminiPromptCache(cacheReference) {
  if (!cacheReference) return;
  geminiCacheRegistry.delete(cacheReference.registryKey);
}

function buildGeminiRequestBody({
  systemInstruction,
  input,
  jsonSchema,
  maxOutputTokens,
  cacheName,
  thinkingBudget = DEFAULT_THINKING_BUDGET,
}) {
  return {
    ...(cacheName
      ? { cachedContent: cacheName }
      : { systemInstruction: { parts: [{ text: systemInstruction }] } }),
    contents: [{
      role: "user",
      parts: input.map(geminiPart),
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: jsonSchema,
      maxOutputTokens,
      temperature: 0,
      thinkingConfig: { thinkingBudget },
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
    },
  };
}

async function requestGeminiStructured({
  systemInstruction,
  cacheNamespace,
  input,
  jsonSchema,
  validator,
  maxOutputTokens,
  thinkingBudget,
  limits,
}) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw createGeminiError("GEMINI_API_KEY is not configured", "GEMINI_AUTH_ERROR");

  const config = runtimeConfig();
  const ceiling = Math.min(limits?.timeoutMs ?? config.geminiTimeoutMs, config.geminiTimeoutMs);
  const maxRetries = Math.min(limits?.maxRetries ?? config.geminiMaxRetries, config.geminiMaxRetries);
  const remaining = limits?.deadlineAt
    ? limits.deadlineAt - Date.now()
    : Number.POSITIVE_INFINITY;
  if (remaining <= 0) {
    throw createGeminiError("Gemini evaluation ran out of time", "GEMINI_TIMEOUT", { retryable: false });
  }
  const timeoutMs = Math.max(1, Math.min(ceiling, remaining));
  const endpoint = `${GEMINI_API_ORIGIN}/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`;
  let cacheReference = await ensureGeminiPromptCache({
    apiKey,
    config,
    namespace: cacheNamespace,
    systemInstruction,
  });
  let requestBody = buildGeminiRequestBody({
    systemInstruction,
    input,
    jsonSchema,
    maxOutputTokens,
    thinkingBudget,
    cacheName: cacheReference?.name,
  });

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
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
        signal: AbortSignal.timeout(timeoutMs),
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
      if (attempt === maxRetries) throw error;
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
      if (cacheReference && (response.status === 400 || response.status === 404)) {
        invalidateGeminiPromptCache(cacheReference);
        cacheReference = null;
        requestBody = buildGeminiRequestBody({
          systemInstruction,
          input,
          jsonSchema,
          maxOutputTokens,
          thinkingBudget,
          cacheName: null,
        });
        incrementMetric("gemini_explicit_cache_fallbacks_total");
        console.warn(`Gemini rejected the cached ${cacheNamespace} prompt; retrying uncached.`);
        attempt -= 1;
        continue;
      }
      const error = geminiHttpError(response.status, body?.error?.message);
      if (!error.retryable || attempt === maxRetries) throw error;
      await delay(retryAfterMilliseconds(response, attempt));
      continue;
    }
    recordGeminiUsage(body);
    const finishReason = body?.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== "STOP") {
      incrementMetric(finishReason === "MAX_TOKENS"
        ? "gemini_max_output_tokens_total"
        : "gemini_incomplete_responses_total");
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

function buildReportSchema(sections, { attireType = null, attireTypes = null, closeUp = false, optionalCodes = null, blazer = false } = {}) {
  const shape = {
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
  if (attireTypes) shape.attire_type = z.enum(attireTypes).optional();
  if (closeUp) shape.close_up = z.unknown().optional();
  if (blazer) shape.blazer = z.unknown().optional();
  for (const key of SECTION_KEYS) {
    if (!sections[key].length) continue;
    shape[key] = z.object(
      Object.fromEntries(sections[key].map((item) => [item.code, optionalCodes?.has(item.code) ? Entry.optional() : Entry]))
    );
  }
  return z.object(shape);
}

function maleFamilyOnlyCodes() {
  const codes = (family) => new Set(SECTION_KEYS.flatMap((key) => checkpointSet("MALE", family)[key].map((item) => item.code)));
  const [first, ...rest] = MALE_ATTIRE_TYPES.map(codes);
  const shared = new Set([...first].filter((code) => rest.every((set) => set.has(code))));
  const combined = maleCombinedSet();
  return new Set(SECTION_KEYS.flatMap((key) => combined[key].map((item) => item.code)).filter((code) => !shared.has(code)));
}

function assertFamilyRows(parsed, sections) {
  const missing = SECTION_KEYS.flatMap((key) => sections[key].map((item) => item.code)
    .filter((code) => !parsed?.[key]?.[code]));
  if (missing.length) {
    throw createGeminiError(
      `Gemini omitted ${missing.length} checkpoint${missing.length === 1 ? "" : "s"} for the attire it chose`,
      "GEMINI_INVALID_RESPONSE"
    );
  }
}

function buildReportJsonSchema(sections, { attireType = null, attireTypes = null, closeUp = false, blazer = false } = {}) {
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
  if (attireTypes) properties.attire_type = { type: "string", enum: [...attireTypes] };
  if (closeUp) properties.close_up = CLOSE_UP_JSON_SCHEMA;
  if (blazer) properties.blazer = BLAZER_JSON_SCHEMA;
  const populatedKeys = SECTION_KEYS.filter((key) => sections[key].length);
  for (const key of populatedKeys) {
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
      ...(attireType || attireTypes ? ["attire_type"] : []),
      ...(closeUp ? ["close_up"] : []),
      ...(blazer ? ["blazer"] : []),
      ...populatedKeys,
    ],
  };
}

function buildFemaleAttireSchema() {
  return z.object({
    subject_visible: z.boolean(),
    attire_type: z.enum(FEMALE_ATTIRE_TYPES),
    image_quality: z.enum(["ADEQUATE", "RETAKE_RECOMMENDED"]),
    visible_regions: z.object({
      face: VISIBILITY,
      upper_body: VISIBILITY,
      lower_body: VISIBILITY,
      footwear: VISIBILITY,
      id_card: VISIBILITY,
      hands: VISIBILITY,
    }),
  });
}

function buildFemaleAttireJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      subject_visible: { type: "boolean" },
      attire_type: { type: "string", enum: [...FEMALE_ATTIRE_TYPES] },
      image_quality: { type: "string", enum: ["ADEQUATE", "RETAKE_RECOMMENDED"] },
      visible_regions: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries([
          "face", "upper_body", "lower_body", "footwear", "id_card", "hands",
        ].map((key) => [key, { type: "string", enum: ["VISIBLE", "PARTIAL", "NOT_VISIBLE"] }])),
        required: ["face", "upper_body", "lower_body", "footwear", "id_card", "hands"],
      },
    },
    required: ["subject_visible", "attire_type", "image_quality", "visible_regions"],
  };
}

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

export function resolveIdCardAbstention(rows, visibleRegions) {
  const row = (rows.general_idcard_check || []).find((item) => item.code === "ID_PRESENT");
  if (!row || row.status !== "N/A") return rows;
  if (visibleRegions?.upper_body !== "VISIBLE") return rows;
  if (visibleRegions?.id_card !== "NOT_VISIBLE") return rows;
  row.status = "FAIL";
  row.reason = "The upper body is visible and no ID card is being worn.";
  return rows;
}

export function resolveMaleAttireVisibility(rows, visibleRegions) {
  const find = (section, code) => (rows?.[section] || []).find((item) => item.code === code);

  const shirtFit = find("attire_check", "M_SHIRT_FIT");
  if (shirtFit?.status === "FAIL") {
    const text = `${shirtFit.observation || ""} ${shirtFit.reason || ""}`.toLowerCase();
    const mentionsTuck = /\b(?:tuck(?:ed|ing)?|untucked|waist(?:band)?|shirt\s+(?:hem|tail))\b/i.test(text);
    const mentionsFitViolation = /\b(?:pull(?:ing|s|ed)?|tight(?:ness)?|bunch(?:ing|ed)?|baggy|looseness|loose[-\s]?fitting|(?:excessively|overly|too|very)\s+loose|ill[-\s]?fitt?ing|poor\s+fit)\b/i.test(text);
    if (mentionsTuck && !mentionsFitViolation) {
      shirtFit.status = "PASS";
      shirtFit.observation = "No shirt-fit violation is identified; shirt tuck is assessed separately.";
      shirtFit.reason = "Tucking is evaluated only in the Shirt Collar / Tuck checkpoint.";
    }
  }

  const lowerBodyInFrame = visibleRegions?.lower_body !== "NOT_VISIBLE";

  const tuck = find("attire_check", "M_SHIRT_COLLAR_TUCK");
  if (tuck?.status === "N/A" && lowerBodyInFrame) {
    tuck.status = "FAIL";
    tuck.reason = "The submitted photograph does not show the required shirt tuck clearly enough to verify compliance.";
    tuck.evidence = "NOT_SHOWN";
  }

  const belt = find("attire_check", "M_BELT");
  if (belt?.status === "N/A" && lowerBodyInFrame) {
    belt.status = "FAIL";
    belt.reason = "The submitted photograph does not show the required belt clearly enough to verify compliance.";
    belt.evidence = "NOT_SHOWN";
  }

  if (!lowerBodyInFrame) {
    for (const code of ["M_SHIRT_COLLAR_TUCK", "M_BELT"]) {
      const row = find("attire_check", code);
      if (row?.status === "FAIL") row.evidence = "NOT_SHOWN";
    }
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

export const WOMEN_FORMAL_NOT_PERMITTED = "Shirt and trousers are not permitted for women; wear a saree or a kurti with dupatta.";

export function resolveWomenFormalAttire(rows, attireType) {
  if (attireType !== "FORMAL") return false;
  const row = (rows.attire_check || []).find((item) => item.code === "W_FORMAL_ATTIRE_TYPE");
  if (!row || row.status === "FAIL") return false;
  row.status = "FAIL";
  row.reason = WOMEN_FORMAL_NOT_PERMITTED;
  return true;
}

export function deriveVerdict(rows, { imageQuality } = {}) {
  const checks = SECTION_KEYS
    .flatMap((key) => rows[key] || [])
    .filter((item) => !INFORMATIONAL_CODES.has(item.code));
  const anyFail = checks.some((item) => item.status === "FAIL");
  const nothingAssessed = checks.length > 0
    && checks.every((item) => item.status === "N/A");

  return {
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

export function unknownGenderEvaluation() {
  return unassessedEvaluation(
    "GENDER_NOT_CONFIGURED",
    "This instructor has no gender recorded, so the applicable dress code could not be determined and no appearance assessment was made. Set the gender on the instructor record; the next check-in will be assessed normally."
  );
}

function sharedDeadline(limits) {
  if (!limits || limits.deadlineAt) return limits;
  const config = runtimeConfig();
  const perAttempt = Math.min(limits.timeoutMs ?? config.geminiTimeoutMs, config.geminiTimeoutMs);
  const attempts = Math.min(limits.maxRetries ?? config.geminiMaxRetries, config.geminiMaxRetries) + 1;
  return { ...limits, deadlineAt: Date.now() + perAttempt * attempts };
}

export async function evaluateImage(imageBuffer, mimeType, gender = null, limits = undefined, options = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error("Instructor image is empty or invalid");
  }
  limits = sharedDeadline(limits);
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
  let closeUps = { parts: [], boxes: {} };
  if (normalizedGender === "FEMALE") {
    const classification = await requestGeminiStructured({
      systemInstruction: buildFemaleAttirePrompt(),
      cacheNamespace: "female-attire",
      input: content,
      jsonSchema: buildFemaleAttireJsonSchema(),
      validator: buildFemaleAttireSchema(),
      maxOutputTokens: 512 + CLASSIFICATION_THINKING_BUDGET,
      thinkingBudget: CLASSIFICATION_THINKING_BUDGET,
      limits,
    });
    attireType = classification.attire_type;

    if (classification.subject_visible === false) {
      incrementMetric("evaluations_unassessed_total");
      return unassessedEvaluation(
        "NO_PERSON_VISIBLE",
        "The photograph does not show the instructor, so no appearance assessment could be made. Retake it as a clear, full-length photo of the person checking in.",
        { imageQuality: "RETAKE_RECOMMENDED" }
      );
    }

    const femaleSections = checkpointSet("FEMALE", attireType);
    parsed = await requestGeminiStructured({
      systemInstruction: buildSystemPrompt("FEMALE", attireType),
      cacheNamespace: `female-${attireType.toLowerCase()}`,
      input: content,
      jsonSchema: buildReportJsonSchema(femaleSections, { blazer: true }),
      validator: buildReportSchema(femaleSections, { blazer: true }),
      maxOutputTokens: 6000 + DEFAULT_THINKING_BUDGET,
      limits,
    });
  } else {
    const maleSections = checkpointSet("MALE", attireType);
    closeUps = await buildCloseUps(imageBuffer, options.bodyRegions);
    const combinedSections = maleCombinedSet();
    const combinedRequest = () => requestGeminiStructured({
      systemInstruction: `${buildMaleReportPrompt()}\n\n${CLOSE_UP_INSTRUCTIONS}`,
      cacheNamespace: "male-combined-closeup",
      input: [...content, ...closeUps.parts],
      jsonSchema: buildReportJsonSchema(combinedSections, { attireTypes: MALE_ATTIRE_TYPES, closeUp: true, blazer: true }),
      validator: buildReportSchema(combinedSections, { attireTypes: MALE_ATTIRE_TYPES, closeUp: true, optionalCodes: maleFamilyOnlyCodes(), blazer: true }),
      maxOutputTokens: 7500 + DEFAULT_THINKING_BUDGET,
      limits,
    });
    const formalRequest = () => requestGeminiStructured({
      systemInstruction: buildSystemPrompt("MALE", "FORMAL"),
      cacheNamespace: "male-formal",
      input: content,
      jsonSchema: buildReportJsonSchema(maleSections, { blazer: true }),
      validator: buildReportSchema(maleSections, { blazer: true }),
      maxOutputTokens: 6000 + DEFAULT_THINKING_BUDGET,
      limits,
    });
    try {
      parsed = await combinedRequest();
    } catch (error) {
      if (error?.code !== "GEMINI_REQUEST_ERROR") throw error;
      incrementMetric("detail_check_fallbacks_total");
      console.warn(`Combined request refused by the provider; reporting formal rows only: ${error.message}`);
      closeUps = { parts: [], boxes: {} };
      parsed = await formalRequest();
    }
    attireType = MALE_ATTIRE_TYPES.includes(parsed.attire_type) ? parsed.attire_type : "FORMAL";
    assertFamilyRows(parsed, checkpointSet("MALE", attireType));
  }
  const sections = checkpointSet(normalizedGender, attireType);

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
  const womenFormalCorrected = normalizedGender === "FEMALE"
    && !blazerWorn(parsed.blazer)
    && resolveWomenFormalAttire(rows, attireType);
  let detailCheck = null;
  if (normalizedGender === "MALE") {
    resolveMaleAttireVisibility(rows, parsed.visible_regions);
    const closeUp = CloseUpAnswer.safeParse(parsed.close_up);
    if (closeUp.success) {
      const { failed, passed } = applyDetailFindings(
        rows,
        findingsFromCloseUp(closeUp.data),
        evidenceBoxes(closeUps.boxes, closeUp.data),
        { croppedRegions: Object.keys(closeUps.boxes) },
      );
      if (failed.length || passed.length) incrementMetric("detail_check_overrides_total");
      detailCheck = {
        version: DETAIL_CHECK_VERSION,
        crops: Object.keys(closeUps.boxes),
        overridden: failed,
        ...(passed.length ? { passed } : {}),
      };
    } else if (parsed.close_up !== undefined) {
      incrementMetric("detail_check_unreadable_total");
    }
  }
  const blazer = applyBlazer(rows, { gender: normalizedGender, attireType, answer: parsed.blazer });
  if (blazer && detailCheck) {
    detailCheck.overridden = detailCheck.overridden.filter((code) => !blazer.passed.includes(code));
  }
  const verdict = attireType === "UNKNOWN"
    ? { overall_status: "UNASSESSED", image_quality: "RETAKE_RECOMMENDED" }
    : deriveVerdict(rows, { imageQuality: parsed.image_quality });
  if (verdict.overall_status === "UNASSESSED") incrementMetric("evaluations_unassessed_total");

  return {
    ...verdict,
    attire_type: attireType,
    ai_summary: `${womenFormalCorrected ? `${WOMEN_FORMAL_NOT_PERMITTED} ` : ""}${blazer ? `${blazer.remark} ` : ""}${parsed.ai_summary || ""}`.slice(0, 1500),
    visible_regions: parsed.visible_regions,
    ...(detailCheck ? { detail_check: detailCheck } : {}),
    ...(attireType === "UNKNOWN" ? { unassessed_reason: "ATTIRE_NOT_IDENTIFIED" } : {}),
    ...rows,
  };
}
