import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { runtimeConfig } from "../config/env.js";
import { ATTIRE_CLASSIFIER_PROMPT, buildSystemPrompt } from "../prompts.js";
import { checkpointSet, INFORMATIONAL_CODES, SECTION_KEYS } from "../checkpoints.js";

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

  // Nothing to tabulate when the photograph does not show the person. The
  // checkpoints are dropped rather than returned as twenty N/A rows, and no
  // verdict is recorded against the instructor for a picture of a wall.
  if (message.parsed.subject_visible === false) {
    return unassessedEvaluation(
      "NO_PERSON_VISIBLE",
      "The photograph does not show the instructor, so no appearance assessment could be made. Retake it as a clear, full-length photo of the person checking in.",
      { imageQuality: "RETAKE_RECOMMENDED" }
    );
  }

  const rows = toOrderedRows(sections, message.parsed);
  const verdict = deriveVerdict(rows, { imageQuality: message.parsed.image_quality });

  return {
    ...verdict,
    attire_type: attireType,
    ai_summary: String(message.parsed.ai_summary || "").slice(0, 1500),
    visible_regions: message.parsed.visible_regions,
    ...rows,
  };
}
