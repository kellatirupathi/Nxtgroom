import sharp from "sharp";
import { z } from "zod";
import { boxToPixels, paddedBox } from "./detailCheck.js";

export const WOMEN_DETAIL_CHECK_VERSION = "2026-10-13.1";

const Box = z.array(z.number()).length(4);
const BOX_JSON_SCHEMA = { type: "array", items: { type: "integer" }, minItems: 4, maxItems: 4 };
const enumSchema = (values) => ({ type: "string", enum: [...values] });

export const RegionBoxes = z.object({
  head_box: Box,
  upper_body_box: Box,
  feet_box: Box,
});

export const REGION_BOXES_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    head_box: BOX_JSON_SCHEMA,
    upper_body_box: BOX_JSON_SCHEMA,
    feet_box: BOX_JSON_SCHEMA,
  },
  required: ["head_box", "upper_body_box", "feet_box"],
};

export const REGION_BOX_INSTRUCTIONS = `### WHERE THE PARTS ARE (region_boxes)
Also report where three parts of her are in the photograph, as [ymin, xmin, ymax, xmax], integers from 0 to 1000 scaled to the photograph's height and width. They are used to cut close-ups for the report, so include the whole part with a little margin.
- head_box: the head with both ears, from the top of the hair to the chin.
- upper_body_box: both shoulders and both arms down past the elbows, with the dupatta or pallu and the top of the kurti or blouse.
- feet_box: both feet and the footwear.
Use [0, 0, 0, 0] for a part that is not in the photograph.`;

const REGION_LABELS = Object.freeze({
  head: "Close-up of the face and ears",
  upper_body: "Close-up of the shoulders and arms",
  feet: "Close-up of the footwear",
});

const CROP_LABELS = Object.freeze({ head: "FACE AND EARS", upper_body: "SHOULDERS AND ARMS", feet: "FEET" });

async function cropRegion(imageBuffer, width, height, box) {
  const rect = boxToPixels(box, width, height);
  const longSide = Math.max(rect.width, rect.height);
  const target = Math.min(1024, Math.max(768, longSide));
  return sharp(imageBuffer)
    .extract(rect)
    .resize({ width: target, height: target, fit: "inside", kernel: "lanczos3" })
    .jpeg({ quality: 92 })
    .toBuffer();
}

export async function buildWomenCloseUps(imageBuffer, regionBoxes) {
  const empty = { parts: [], boxes: {}, armImage: null };
  const parsed = RegionBoxes.safeParse(regionBoxes);
  if (!parsed.success) return empty;
  let width;
  let height;
  try {
    ({ width, height } = await sharp(imageBuffer).metadata());
  } catch {
    return empty;
  }
  if (!width || !height) return empty;

  const parts = [];
  const boxes = {};
  let armImage = null;
  for (const [region, key] of [["head", "head_box"], ["upper_body", "upper_body_box"], ["feet", "feet_box"]]) {
    const box = paddedBox(parsed.data[key], { margin: 0.08 });
    if (!box) continue;
    try {
      const data = await cropRegion(imageBuffer, width, height, box);
      parts.push({ type: "input_text", text: `${CROP_LABELS[region]} close-up:` });
      parts.push({ type: "input_image", mimeType: "image/jpeg", data: data.toString("base64") });
      boxes[region] = box;
      if (region === "upper_body") armImage = data;
    } catch {
    }
  }
  if (parts.length) {
    parts.unshift({
      type: "input_text",
      text: "Close-up crops of the same photograph: her face and ears, her shoulders and arms, and her feet. Use them to answer women_close_up.",
    });
  }
  return { parts, boxes, armImage };
}

const SLEEVE = ["SLEEVELESS", "CAP", "ABOVE_MIDDLE", "MIDDLE_OF_UPPER_ARM", "ABOVE_ELBOW", "AT_ELBOW", "BELOW_ELBOW", "NOT_VISIBLE"];
const PRINT = ["PLAIN", "TINY_SUBTLE_PATTERN", "NOTICEABLE_PRINT", "UNCLEAR"];
const DUPATTA = ["BOTH_SHOULDERS", "ONE_SHOULDER", "AROUND_NECK_ONLY", "NONE", "UNCLEAR"];
const FOOTWEAR = ["CLOSED_TOE", "OPEN_TOE_SANDALS", "SLIPPERS_OR_FLIP_FLOPS", "SNEAKERS_OR_SPORTS", "BAREFOOT", "NOT_VISIBLE"];
const EARRINGS = ["NONE", "UP_TO_2CM", "LARGER_THAN_2CM", "NOT_VISIBLE"];
const FIT = ["NORMAL_EASE", "LOOSE_OVERSIZED", "TOO_TIGHT", "UNCLEAR"];

export const WomenCloseUpAnswer = z.object({
  sleeve_left: z.enum(SLEEVE),
  sleeve_right: z.enum(SLEEVE),
  sleeve_observation: z.string(),
  print: z.enum(PRINT),
  print_observation: z.string(),
  dupatta: z.enum(DUPATTA),
  dupatta_observation: z.string(),
  footwear: z.enum(FOOTWEAR),
  footwear_observation: z.string(),
  earrings: z.enum(EARRINGS),
  earrings_observation: z.string(),
  fit: z.enum(FIT),
  fit_observation: z.string(),
});

export const WOMEN_CLOSE_UP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sleeve_left: enumSchema(SLEEVE),
    sleeve_right: enumSchema(SLEEVE),
    sleeve_observation: { type: "string" },
    print: enumSchema(PRINT),
    print_observation: { type: "string" },
    dupatta: enumSchema(DUPATTA),
    dupatta_observation: { type: "string" },
    footwear: enumSchema(FOOTWEAR),
    footwear_observation: { type: "string" },
    earrings: enumSchema(EARRINGS),
    earrings_observation: { type: "string" },
    fit: enumSchema(FIT),
    fit_observation: { type: "string" },
  },
  required: [
    "sleeve_left", "sleeve_right", "sleeve_observation",
    "print", "print_observation",
    "dupatta", "dupatta_observation",
    "footwear", "footwear_observation",
    "earrings", "earrings_observation",
    "fit", "fit_observation",
  ],
};

const SLEEVE_SCALE = `Where the sleeve hem ends on the arm, for each arm separately: find the shoulder point and the elbow bend, then find the boundary where the sleeve fabric (its colour or print) stops and bare skin begins. A puffed or gathered sleeve is judged by that hem, not by its fullness at the shoulder.
SLEEVELESS: no sleeve. CAP: a sleeve ending just below the shoulder. ABOVE_MIDDLE: ending in the upper half of the upper arm. MIDDLE_OF_UPPER_ARM: ending about halfway from the shoulder to the elbow. ABOVE_ELBOW: ending between halfway and the elbow. AT_ELBOW: ending at the elbow. BELOW_ELBOW: three-quarter or full sleeves. NOT_VISIBLE: the arm or its hem is hidden (by the pallu, the dupatta or the pose) or out of frame.`;

export const WOMEN_CLOSE_UP_INSTRUCTIONS = `## CLOSE-UP ANSWERS FOR HER OUTFIT (women_close_up)

Answer women_close_up from the close-up crops when the request includes them (labelled FACE AND EARS, SHOULDERS AND ARMS and FEET), and from the photograph otherwise. Answer only from what is visible. The sleeve, print, dupatta, footwear, earring and kurti fit rows must agree with these answers. Answer every field even when a row does not apply to her attire family.

SLEEVES
- sleeve_left, sleeve_right: ${SLEEVE_SCALE}
- sleeve_observation: one sentence naming the sleeve colour or print and where its hem ends on each arm.

KURTI PRINT
- print: PLAIN for a solid colour; TINY_SUBTLE_PATTERN for small dots or buttis that read as plain at a glance; NOTICEABLE_PRINT for any print you can see from across the room - floral, botanical, abstract, geometric or block; UNCLEAR when you cannot tell. Answer about the kurti, or about the saree or top she wears.
- print_observation: one sentence naming the colour and the print you saw.

DUPATTA
- dupatta: BOTH_SHOULDERS when it covers both shoulders; ONE_SHOULDER when it lies over only one; AROUND_NECK_ONLY when it hangs from the neck without covering the shoulders; NONE when there is no dupatta; UNCLEAR when you cannot tell. For a saree or other outfit without a dupatta, answer NONE.
- dupatta_observation: one sentence naming which shoulders it covers.

FOOTWEAR
- footwear: look at the toes first. CLOSED_TOE only when the toes are covered (pumps, bellies, ballet flats, loafers, closed shoes or boots); OPEN_TOE_SANDALS for any sandal with the toes showing, including formal strap sandals and kolhapuris; SLIPPERS_OR_FLIP_FLOPS for slippers, chappals and flip-flops; SNEAKERS_OR_SPORTS for sneakers or sports shoes; BAREFOOT; NOT_VISIBLE when the feet are out of frame or hidden.
- footwear_observation: one sentence naming the footwear and whether the toes are visible.

EARRINGS
- earrings: NONE; UP_TO_2CM for studs or small earrings no longer than about a third of the ear; LARGER_THAN_2CM for drops, dangling or jhumka earrings longer than that; NOT_VISIBLE when the ears are hidden. Never call a drop or jhumka a stud.
- earrings_observation: one sentence naming the earring style and its length against the ear.

KURTI FIT
- fit: NORMAL_EASE when the kurti follows the body with normal ease; LOOSE_OVERSIZED when it hangs far off the body, its shoulder seam drops down the upper arm or its sleeves cover the hands; TOO_TIGHT when it pulls across the chest or hips; UNCLEAR when you cannot tell or she is not wearing a kurti.
- fit_observation: one sentence naming where the shoulder seam sits and how the kurti falls.`;

export const SleeveSecondLook = z.object({
  sleeve_left: z.enum(SLEEVE),
  sleeve_right: z.enum(SLEEVE),
  observation: z.string(),
});

export const SLEEVE_SECOND_LOOK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sleeve_left: enumSchema(SLEEVE),
    sleeve_right: enumSchema(SLEEVE),
    observation: { type: "string" },
  },
  required: ["sleeve_left", "sleeve_right", "observation"],
};

export const SLEEVE_SECOND_LOOK_INSTRUCTIONS = `You are shown a close-up of a woman's shoulders and arms, cut from a check-in photograph. Answer one question only: where does the hem of each sleeve end on the arm?

${SLEEVE_SCALE}

observation: one sentence naming the sleeve colour or print and where its hem ends on each arm. Judge only what the close-up shows.`;

export const SLEEVE_SECOND_LOOK_PROMPT = "Where does the hem of each sleeve end on the arm in this close-up?";

const LONG_ENOUGH = new Set(["MIDDLE_OF_UPPER_ARM", "ABOVE_ELBOW", "AT_ELBOW", "BELOW_ELBOW"]);

export function sleeveVerdict(left, right) {
  const seen = [left, right].filter((value) => value && value !== "NOT_VISIBLE");
  if (!seen.length) return null;
  return seen.some((value) => LONG_ENOUGH.has(value)) ? "PASS" : "FAIL";
}

export const SLEEVE_CODES = Object.freeze({
  SAREE: "W_SAREE_BLOUSE",
  KURTI_WITH_DUPATTA: "W_KURTI_NECKLINE_SLEEVES",
  FORMAL: "W_FORMAL_TOP",
});

const SLEEVE_WORDS = /\bsleeve/i;
const OTHER_TOP_FAULTS = /\b(?:neckline|strap|safety\s*pin|sheer|transparent|see-through|translucent|tight|pulls?|pulling|stain|torn|tear|casual|novelty)\b/i;

function findRow(rows, code) {
  for (const items of Object.values(rows)) {
    if (!Array.isArray(items)) continue;
    const row = items.find((item) => item?.code === code);
    if (row) return row;
  }
  return null;
}

function rowText(row) {
  return `${row?.observation || ""} ${row?.reason || ""}`;
}

function failRow(row, observation, reason) {
  row.status = "FAIL";
  row.observation = observation.slice(0, 1000);
  row.reason = reason.slice(0, 1000);
  delete row.evidence;
  row.detail_override = true;
}

function passRow(row, observation, reason) {
  row.status = "PASS";
  row.observation = observation.slice(0, 1000);
  row.reason = reason.slice(0, 1000);
  delete row.evidence;
  row.detail_override = true;
}

function markEvidence(row, boxes, region) {
  if (row && boxes?.[region]) {
    row.evidence_box = boxes[region];
    row.evidence_label = REGION_LABELS[region];
  }
}

export function sleeveFailIsAboutSleeves(row) {
  if (row?.status !== "FAIL") return false;
  const text = rowText(row);
  return SLEEVE_WORDS.test(text) && !OTHER_TOP_FAULTS.test(text);
}

function passSareePresentation(rows) {
  const presentation = findRow(rows, "W_SAREE_PRESENTATION");
  if (presentation?.status !== "FAIL") return null;
  const text = rowText(presentation);
  if (!/\b(?:sleeve|blouse)\b/i.test(text)) return null;
  passRow(
    presentation,
    "The overall presentation is professional; the blouse sleeves were confirmed to meet the standard.",
    "The only fault named was the blouse sleeve length, which the close-up of the arms shows meets the standard.",
  );
  return "W_SAREE_PRESENTATION";
}

export function passSleeves(rows, attireType, observation, reason) {
  const code = SLEEVE_CODES[attireType];
  const row = code ? findRow(rows, code) : null;
  if (!row || !sleeveFailIsAboutSleeves(row)) return [];
  passRow(row, observation, reason);
  const passed = [code];
  if (attireType === "SAREE") {
    const presentation = passSareePresentation(rows);
    if (presentation) passed.push(presentation);
  }
  return passed;
}

export function sleeveRowToConfirm(rows, attireType) {
  const code = SLEEVE_CODES[attireType];
  const row = code ? findRow(rows, code) : null;
  return row && sleeveFailIsAboutSleeves(row) ? row : null;
}

const NEGATION = /\b(?:no|not|without|nor|neither|never|none|instead\s+of|rather\s+than|free\s+of|isn't|aren't|absence\s+of|ruled\s+out)\b/i;
const CLAUSE_BREAK = /[.;:!?]|\bbut\b|\bhowever\b|\bwhereas\b|\balthough\b/gi;

function clauseBefore(text, index) {
  let start = 0;
  for (const match of text.slice(0, index).matchAll(CLAUSE_BREAK)) start = match.index + match[0].length;
  return text.slice(start, index);
}

export function unnegatedMention(text, pattern) {
  const regex = new RegExp(pattern.source, "gi");
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (!NEGATION.test(clauseBefore(text, match.index))) return match[0];
  }
  return null;
}

const CONTRADICTIONS = [
  {
    code: "W_FOOTWEAR_TYPE",
    pattern: /\b(?:sandals?|slippers?|flip[-\s]?flops?|chappals?|kolhapuris?|open[-\s]?toed?|sneakers?|sports\s+shoes?|trainers|barefoot)\b/,
    reason: (word) => `The report itself describes ${word}; only closed-toe formal footwear is permitted.`,
  },
  {
    code: "W_KURTI_MATERIAL",
    pattern: /\b(?:floral|flowers?|flowery|botanical|bold\s+print|large\s+print|abstract\s+print|block\s+print|graphic\s+print|printed)\b/,
    unless: /\b(?:tiny|subtle|faint|small\s+dots?|buttis?|reads?\s+as\s+plain)\b/i,
    reason: (word) => `The report itself describes a ${word} kurti; a plain, solid-colour kurti is required.`,
  },
  {
    code: "W_BOTTOM_WEAR",
    pattern: /\b(?:leggings?|jeggings?|churidars?|jeans|denim|patiala|skin[-\s]?tight|cling(?:s|ing)?\s+to\s+the\s+legs?)\b/,
    reason: (word) => `The report itself describes ${word} bottom wear, which is not permitted.`,
  },
  {
    code: "W_DUPATTA",
    pattern: /\b(?:one\s+shoulder|single\s+shoulder|only\s+(?:the|her)\s+(?:left|right)\s+shoulder|(?:left|right)\s+shoulder\s+only|around\s+the\s+neck\s+only|no\s+dupatta)\b/,
    reason: () => "The report itself describes the dupatta not covering both shoulders; it must cover both shoulders.",
  },
  {
    code: "W_EARRINGS",
    pattern: /\b(?:larger\s+than\s+(?:about\s+)?2\s*cm|over-?sized|chandelier|large\s+(?:drop|dangling|hoop|jhumka)s?)\b/,
    reason: (word) => `The report itself describes ${word} earrings, larger than the 2 cm limit.`,
  },
  {
    code: "W_KURTI_FIT_LENGTH",
    pattern: /\b(?:over-?sized|baggy|tent-?like|too\s+loose|very\s+loose|too\s+tight|very\s+tight)\b/,
    reason: (word) => `The report itself describes the kurti as ${word}; it must fit with normal ease.`,
  },
];

export function applyWomenContradictions(rows) {
  const failed = [];
  for (const rule of CONTRADICTIONS) {
    const row = findRow(rows, rule.code);
    if (row?.status !== "PASS") continue;
    const text = String(row.observation || "");
    if (rule.unless?.test(text)) continue;
    const word = unnegatedMention(text, rule.pattern);
    if (!word) continue;
    row.status = "FAIL";
    row.reason = rule.reason(word.toLowerCase()).slice(0, 1000);
    delete row.evidence;
    row.detail_override = true;
    failed.push(rule.code);
  }
  return failed;
}

const FOOTWEAR_FAIL = Object.freeze({
  OPEN_TOE_SANDALS: "The close-up of the footwear shows open-toe sandals; only closed-toe formal footwear is permitted.",
  SLIPPERS_OR_FLIP_FLOPS: "The close-up of the footwear shows slippers or flip-flops; only closed-toe formal footwear is permitted.",
  SNEAKERS_OR_SPORTS: "The close-up of the footwear shows sneakers or sports shoes, not formal footwear.",
  BAREFOOT: "The close-up of the footwear shows her barefoot; closed-toe formal footwear is required.",
});

const DUPATTA_FAIL = Object.freeze({
  ONE_SHOULDER: "The dupatta covers only one shoulder; it must cover both shoulders.",
  AROUND_NECK_ONLY: "The dupatta hangs around the neck without covering the shoulders; it must cover both shoulders.",
  NONE: "No dupatta is worn; a dupatta covering both shoulders is required.",
});

export function applyWomenFindings(rows, answer, { attireType, boxes = {} } = {}) {
  const failed = [];
  const passed = [];
  const sentence = (text, fallback) => (String(text || "").trim() || fallback);
  const kurti = attireType === "KURTI_WITH_DUPATTA";

  const sleeveCode = SLEEVE_CODES[attireType];
  const sleeveRow = sleeveCode ? findRow(rows, sleeveCode) : null;
  if (sleeveRow) {
    markEvidence(sleeveRow, boxes, "upper_body");
    const verdict = sleeveVerdict(answer.sleeve_left, answer.sleeve_right);
    const seen = sentence(answer.sleeve_observation, "The sleeves.");
    if (verdict === "PASS" && sleeveRow.status === "FAIL") {
      passed.push(...passSleeves(
        rows,
        attireType,
        `Close-up of the shoulders and arms: ${seen}`,
        "The close-up of the arms shows the sleeve reaching at least halfway from the shoulder to the elbow.",
      ));
    } else if (verdict === "FAIL" && sleeveRow.status === "PASS") {
      failRow(
        sleeveRow,
        `Close-up of the shoulders and arms: ${seen}`,
        "The close-up of the arms shows the sleeve ending well short of halfway from the shoulder to the elbow.",
      );
      failed.push(sleeveCode);
    }
  }

  if (kurti) {
    const material = findRow(rows, "W_KURTI_MATERIAL");
    markEvidence(material, boxes, "upper_body");
    if (material?.status === "PASS" && answer.print === "NOTICEABLE_PRINT") {
      failRow(
        material,
        `Close-up of the shoulders and arms: ${sentence(answer.print_observation, "A printed kurti.")}`,
        "The kurti has a noticeable print; a plain, solid-colour kurti is required.",
      );
      failed.push("W_KURTI_MATERIAL");
    }

    const dupatta = findRow(rows, "W_DUPATTA");
    markEvidence(dupatta, boxes, "upper_body");
    if (dupatta?.status === "PASS" && DUPATTA_FAIL[answer.dupatta]) {
      failRow(
        dupatta,
        `Close-up of the shoulders and arms: ${sentence(answer.dupatta_observation, "The dupatta.")}`,
        DUPATTA_FAIL[answer.dupatta],
      );
      failed.push("W_DUPATTA");
    }

    const fit = findRow(rows, "W_KURTI_FIT_LENGTH");
    if (fit?.status === "PASS" && (answer.fit === "LOOSE_OVERSIZED" || answer.fit === "TOO_TIGHT")) {
      failRow(
        fit,
        sentence(answer.fit_observation, "The kurti fit."),
        answer.fit === "LOOSE_OVERSIZED"
          ? "The kurti is loose and oversized; it must fit with normal ease."
          : "The kurti is too tight; it must fit with normal ease.",
      );
      failed.push("W_KURTI_FIT_LENGTH");
    }
  }

  const footwear = findRow(rows, "W_FOOTWEAR_TYPE");
  markEvidence(footwear, boxes, "feet");
  if (footwear?.status === "PASS" && FOOTWEAR_FAIL[answer.footwear]) {
    failRow(
      footwear,
      `Close-up of the footwear: ${sentence(answer.footwear_observation, "The footwear.")}`,
      FOOTWEAR_FAIL[answer.footwear],
    );
    failed.push("W_FOOTWEAR_TYPE");
  }

  const earrings = findRow(rows, "W_EARRINGS");
  markEvidence(earrings, boxes, "head");
  if (earrings?.status === "PASS" && answer.earrings === "LARGER_THAN_2CM") {
    failRow(
      earrings,
      `Close-up of the face and ears: ${sentence(answer.earrings_observation, "The earrings.")}`,
      "The earrings are longer than the 2 cm limit.",
    );
    failed.push("W_EARRINGS");
  }

  return { failed, passed };
}
