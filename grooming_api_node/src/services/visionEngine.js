import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { runtimeConfig } from "../config/env.js";
import { SYSTEM_PROMPT } from "../prompts.js";

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

const CheckItem = z.object({
  checkpoint_name: z.string().min(1).max(120),
  observation: z.string().min(1).max(1000),
  status: z.enum(["PASS", "FAIL", "N/A"]),
  reason: z.string().min(1).max(1000),
});

const GroomingReport = z.object({
  overall_status: z.enum(["COMPLIANT", "NON_COMPLIANT"]),
  // What the instructor is wearing, so the weekly saree/kurti split can be
  // counted. UNKNOWN when the photo does not show enough to tell, which must
  // not be silently counted as either.
  attire_type: z.enum(["FORMAL", "SAREE", "KURTI_WITH_DUPATTA", "UNKNOWN"]),
  requires_human_review: z.boolean(),
  image_quality: z.enum(["ADEQUATE", "RETAKE_RECOMMENDED"]),
  ai_summary: z.string().min(1).max(1500),
  general_idcard_check: z.array(CheckItem).min(1).max(20),
  grooming_check: z.array(CheckItem).min(1).max(20),
  attire_check: z.array(CheckItem).min(1).max(20),
  accessories_check: z.array(CheckItem).min(1).max(20),
  footwear_check: z.array(CheckItem).min(1).max(20),
});

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

export async function evaluateImage(imageBuffer, mimeType, gender = null) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error("Instructor image is empty or invalid");
  }
  const normalizedGender = gender?.toUpperCase();
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

  content.push({
    type: "text",
    text: `Now evaluate the instructor image. The instructor's gender is ${normalizedGender || "not provided"}.`,
  });
  content.push({
    type: "image_url",
    image_url: {
      url: `data:${mimeType};base64,${imageBuffer.toString("base64")}`,
      detail: "high",
    },
  });

  const response = await getClient().beta.chat.completions.parse({
    model: process.env.OPENAI_MODEL || "gpt-4o-2024-11-20",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
    response_format: zodResponseFormat(GroomingReport, "grooming_report"),
    temperature: 0,
    max_completion_tokens: 3000,
  });

  const message = response.choices?.[0]?.message;
  if (message?.refusal) throw new Error("The image evaluation was refused by the model");
  if (!message?.parsed) throw new Error("The model returned no structured evaluation");
  const report = message.parsed;
  const checks = [
    ...report.general_idcard_check,
    ...report.grooming_check,
    ...report.attire_check,
    ...report.accessories_check,
    ...report.footwear_check,
  ];
  // A photo that shows nothing assessable comes back with every checkpoint
  // N/A. That is not a compliance verdict, so the pass/fail rule below cannot
  // apply to it: previously such a photo was rejected as "inconsistent",
  // retried three times, and left the attendance record permanently in error.
  // Treat it as unevaluable and send it for human review instead.
  const assessed = checks.filter((item) => item.status !== "N/A");
  if (assessed.length === 0) {
    return {
      ...report,
      overall_status: "NON_COMPLIANT",
      image_quality: "RETAKE_RECOMMENDED",
      requires_human_review: true,
    };
  }

  const expectedStatus = checks.some((item) => item.status === "FAIL")
    ? "NON_COMPLIANT"
    : "COMPLIANT";
  if (report.overall_status !== expectedStatus) {
    throw new Error("The model returned an internally inconsistent evaluation");
  }
  const criticalChecks = [
    ...report.general_idcard_check,
    ...report.attire_check,
    ...report.footwear_check,
  ];
  const reviewRequired = expectedStatus === "NON_COMPLIANT"
    || report.image_quality === "RETAKE_RECOMMENDED"
    || criticalChecks.some((item) => item.status === "N/A");
  if (reviewRequired && !report.requires_human_review) {
    throw new Error("The model omitted a required human-review flag");
  }
  return report;
}
