import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runtimeConfig } from "../config/env.js";
import { ATTIRE_CLASSIFIER_PROMPT, buildSystemPrompt } from "../prompts.js";
import { checkpointSet, INFORMATIONAL_CODES, SECTION_KEYS } from "../checkpoints.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE_DIR = path.join(__dirname, "..", "..", "reference_images");
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_GEMINI_MODEL = "gemini-3.7-flash";

let referenceCachePromise = null;

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

const AttireClassification = z.object({
  attire_type: z.enum(["FORMAL", "SAREE", "KURTI_WITH_DUPATTA", "UNKNOWN"]),
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

const ATTIRE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    attire_type: { type: "string", enum: ["FORMAL", "SAREE", "KURTI_WITH_DUPATTA", "UNKNOWN"] },
  },
  required: ["attire_type"],
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

function extractGeminiText(interaction) {
  return (interaction?.steps || [])
    .filter((step) => step?.type === "model_output")
    .flatMap((step) => step.content || [])
    .filter((content) => content?.type === "text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("")
    .trim();
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
  const requestBody = {
    model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    store: false,
    system_instruction: systemInstruction,
    input,
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: jsonSchema,
    },
    generation_config: {
      max_output_tokens: maxOutputTokens,
      thinking_level: "medium",
      thinking_summaries: "none",
    },
  };

  for (let attempt = 0; attempt <= config.geminiMaxRetries; attempt += 1) {
    let response;
    try {
      response = await fetch(GEMINI_INTERACTIONS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(config.geminiTimeoutMs),
      });
    } catch (cause) {
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
      const error = geminiHttpError(response.status, body?.error?.message);
      if (!error.retryable || attempt === config.geminiMaxRetries) throw error;
      await delay(retryAfterMilliseconds(response, attempt));
      continue;
    }
    if (body.status !== "completed") {
      throw createGeminiError(
        `Gemini did not complete the evaluation (status: ${body.status || "unknown"})`,
        "GEMINI_INCOMPLETE_RESPONSE"
      );
    }

    const text = extractGeminiText(body);
    if (!text) {
      throw createGeminiError("Gemini returned no structured evaluation", "GEMINI_INVALID_RESPONSE");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw createGeminiError("Gemini returned invalid structured JSON", "GEMINI_INVALID_RESPONSE");
    }
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
function buildReportSchema(sections) {
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
  for (const key of SECTION_KEYS) {
    shape[key] = z.object(
      Object.fromEntries(sections[key].map((item) => [item.code, Entry]))
    );
  }
  return z.object(shape);
}

function buildReportJsonSchema(sections) {
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
    required: ["subject_visible", "image_quality", "ai_summary", "visible_regions", ...SECTION_KEYS],
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
    overall_status: anyFail ? "NON_COMPLIANT" : "COMPLIANT",
    image_quality: nothingAssessed ? "RETAKE_RECOMMENDED" : (imageQuality || "ADEQUATE"),
  };
}

function isReferenceRelevant(filename, gender) {
  const name = filename.toLowerCase();
  if (gender === "MALE" && name.startsWith("women")) return false;
  if (gender === "FEMALE" && (name.startsWith("men") || name.startsWith("beard"))) return false;
  return true;
}

async function loadReferenceImages() {
  const filenames = (await fs.readdir(REFERENCE_DIR))
    .filter((filename) => filename.toLowerCase().endsWith(".jpg"))
    .sort();
  // Whatever is in the folder is the reference set. This asserted a count of
  // exactly eight, so removing an image that no longer had a checkpoint —
  // spectacles, once eyewear was dropped — took the whole API down on boot
  // rather than simply sending one picture fewer. An empty folder is still a
  // real failure: the standards are what the model compares against.
  if (filenames.length === 0) {
    throw new Error(`No grooming reference images were found in ${REFERENCE_DIR}`);
  }
  console.log(`Loaded ${filenames.length} grooming reference images.`);
  return Promise.all(filenames.map(async (filename) => ({
    filename,
    data: (await fs.readFile(path.join(REFERENCE_DIR, filename))).toString("base64"),
  })));
}

function getReferenceImages() {
  referenceCachePromise ||= loadReferenceImages();
  return referenceCachePromise;
}

export async function verifyVisionAssets() {
  await getReferenceImages();
  return true;
}

function instructorImagePart(imageBuffer, mimeType) {
  return {
    type: "image",
    data: imageBuffer.toString("base64"),
    mime_type: mimeType,
    resolution: "high",
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

/**
 * Names the garment before the main pass.
 *
 * A woman's attire checkpoints depend on the answer, and the garment has to be
 * read from the photograph rather than assumed from her gender: a woman in
 * formal trousers is exactly the case the weekly rotation needs to catch, and
 * inferring the garment from the person would hide it.
 */
async function classifyAttire(imageBuffer, mimeType) {
  const parsed = await requestGeminiStructured({
    systemInstruction: ATTIRE_CLASSIFIER_PROMPT,
    input: [instructorImagePart(imageBuffer, mimeType)],
    jsonSchema: ATTIRE_JSON_SCHEMA,
    validator: AttireClassification,
    maxOutputTokens: 512,
  });
  return parsed.attire_type;
}

export async function evaluateImage(imageBuffer, mimeType, gender = null) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error("Instructor image is empty or invalid");
  }
  const normalizedGender = gender?.toUpperCase();
  if (normalizedGender !== "MALE" && normalizedGender !== "FEMALE") {
    return unknownGenderEvaluation();
  }

  // Men are assessed against one attire set whatever they are wearing, so only
  // a woman's report depends on naming the garment first.
  const attireType = normalizedGender === "FEMALE"
    ? await classifyAttire(imageBuffer, mimeType)
    : "FORMAL";

  const sections = checkpointSet(normalizedGender, attireType);
  const references = await getReferenceImages();
  const content = [{
    type: "text",
    text: "Here are the reference images for the NxtWave Grooming Standards (DOs and DON'Ts).",
  }];
  for (const reference of references) {
    if (!isReferenceRelevant(reference.filename, normalizedGender)) continue;
    content.push({
      type: "image",
      data: reference.data,
      mime_type: "image/jpeg",
      resolution: "high",
    });
  }
  content.push({ type: "text", text: "Now assess the instructor in the final image." });
  content.push(instructorImagePart(imageBuffer, mimeType));

  const parsed = await requestGeminiStructured({
    systemInstruction: buildSystemPrompt(normalizedGender, attireType),
    input: content,
    jsonSchema: buildReportJsonSchema(sections),
    validator: buildReportSchema(sections),
    maxOutputTokens: 6000,
  });

  // Nothing to tabulate when the photograph does not show the person. The
  // checkpoints are dropped rather than returned as twenty N/A rows, and no
  // verdict is recorded against the instructor for a picture of a wall.
  if (parsed.subject_visible === false) {
    return unassessedEvaluation(
      "NO_PERSON_VISIBLE",
      "The photograph does not show the instructor, so no appearance assessment could be made. Retake it as a clear, full-length photo of the person checking in.",
      { imageQuality: "RETAKE_RECOMMENDED" }
    );
  }

  const rows = toOrderedRows(sections, parsed);
  resolveIdCardAbstention(rows, parsed.visible_regions);
  const verdict = deriveVerdict(rows, { imageQuality: parsed.image_quality });

  return {
    ...verdict,
    attire_type: attireType,
    ai_summary: String(parsed.ai_summary || "").slice(0, 1500),
    visible_regions: parsed.visible_regions,
    ...rows,
  };
}
