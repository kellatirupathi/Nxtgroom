import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { runtimeConfig } from "../config/env.js";
import { ATTIRE_CLASSIFIER_PROMPT, buildSystemPrompt } from "../prompts.js";
import { checkpointSet, SECTION_KEYS } from "../checkpoints.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE_DIR = path.join(__dirname, "..", "..", "reference_images");

let client = null;
let referenceCachePromise = null;

function getClient() {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    client = new OpenAI({
      apiKey,
      timeout: runtimeConfig().openAiTimeoutMs,
      maxRetries: runtimeConfig().openAiMaxRetries,
    });
  }
  return client;
}

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
    requires_human_review: z.boolean(),
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
 * The compliance verdict, computed from the checkpoints rather than asked for.
 *
 * The model used to be asked for overall_status and then checked against the
 * rows; a disagreement threw away an otherwise sound evaluation and left the
 * attendance record in error. The rule has one line, so there is nothing to
 * ask: any FAIL means non-compliant, and N/A never does.
 */
export function deriveVerdict(rows, { imageQuality, modelRequestedReview } = {}) {
  const checks = SECTION_KEYS.flatMap((key) => rows[key] || []);
  const anyFail = checks.some((item) => item.status === "FAIL");
  // A photo showing nothing assessable comes back entirely N/A. That is not a
  // verdict about the instructor, so it asks for a retake instead of one.
  const nothingAssessed = checks.length > 0
    && checks.every((item) => item.status === "N/A");
  const resolvedQuality = nothingAssessed ? "RETAKE_RECOMMENDED" : (imageQuality || "ADEQUATE");
  // ID card, attire and footwear carry the standard. If one could not be seen,
  // the report is incomplete regardless of what the rest of it says.
  const criticalNotAssessed = [
    ...(rows.general_idcard_check || []),
    ...(rows.attire_check || []),
    ...(rows.footwear_check || []),
  ].some((item) => item.status === "N/A");

  return {
    overall_status: anyFail ? "NON_COMPLIANT" : "COMPLIANT",
    image_quality: resolvedQuality,
    requires_human_review: Boolean(modelRequestedReview)
      || anyFail
      || resolvedQuality === "RETAKE_RECOMMENDED"
      || criticalNotAssessed,
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
  if (filenames.length !== 8) {
    throw new Error(`Expected 8 grooming reference images, found ${filenames.length}`);
  }
  return Promise.all(filenames.map(async (filename) => ({
    filename,
    dataUrl: `data:image/jpeg;base64,${(await fs.readFile(path.join(REFERENCE_DIR, filename))).toString("base64")}`,
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
    type: "image_url",
    image_url: {
      url: `data:${mimeType};base64,${imageBuffer.toString("base64")}`,
      detail: "high",
    },
  };
}

/**
 * The evaluation returned when no gender is on the instructor record.
 *
 * Every dress-code rule below the ID card differs by gender, so there is no
 * honest verdict to give: assessing against both — which is what happened
 * before — measured men against saree standards and produced failures for
 * rules that never applied to them. This makes no compliance claim at all and
 * asks for the missing field instead.
 */
export function unknownGenderEvaluation() {
  return {
    overall_status: "COMPLIANT",
    attire_type: "UNKNOWN",
    requires_human_review: true,
    image_quality: "ADEQUATE",
    ai_summary:
      "This instructor has no gender recorded, so the applicable dress code could not be determined and no appearance assessment was made. Set the gender on the instructor record; the next check-in will be assessed normally.",
    general_idcard_check: [],
    grooming_check: [],
    attire_check: [],
    accessories_check: [],
    footwear_check: [],
    visible_regions: null,
    unassessed_reason: "GENDER_NOT_CONFIGURED",
  };
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
  const response = await getClient().beta.chat.completions.parse({
    model: process.env.OPENAI_MODEL || "gpt-4o-2024-11-20",
    messages: [
      { role: "system", content: ATTIRE_CLASSIFIER_PROMPT },
      { role: "user", content: [instructorImagePart(imageBuffer, mimeType)] },
    ],
    response_format: zodResponseFormat(AttireClassification, "attire_classification"),
    temperature: 0,
    max_completion_tokens: 100,
  });
  return response.choices?.[0]?.message?.parsed?.attire_type || "UNKNOWN";
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
      type: "image_url",
      image_url: { url: reference.dataUrl, detail: "high" },
    });
  }
  content.push({ type: "text", text: "Now assess the instructor in the final image." });
  content.push(instructorImagePart(imageBuffer, mimeType));

  const response = await getClient().beta.chat.completions.parse({
    model: process.env.OPENAI_MODEL || "gpt-4o-2024-11-20",
    messages: [
      { role: "system", content: buildSystemPrompt(normalizedGender, attireType) },
      { role: "user", content },
    ],
    response_format: zodResponseFormat(
      buildReportSchema(sections),
      "appearance_report"
    ),
    temperature: 0,
    max_completion_tokens: 6000,
  });

  const message = response.choices?.[0]?.message;
  if (message?.refusal) throw new Error("The image evaluation was refused by the model");
  if (!message?.parsed) throw new Error("The model returned no structured evaluation");

  const rows = toOrderedRows(sections, message.parsed);
  const verdict = deriveVerdict(rows, {
    imageQuality: message.parsed.image_quality,
    modelRequestedReview: message.parsed.requires_human_review,
  });

  return {
    ...verdict,
    attire_type: attireType,
    ai_summary: String(message.parsed.ai_summary || "").slice(0, 1500),
    visible_regions: message.parsed.visible_regions,
    ...rows,
  };
}
