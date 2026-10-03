import sharp from "sharp";
import { z } from "zod";

/**
 * A close-up look at the parts of a man's appearance that a full-length
 * photograph shows too small to judge reliably: the face (hair, beard and
 * moustache), the waist (tuck and belt), the trousers and the shoes. Asked in
 * the same request as the report itself, so a man's photograph still costs one
 * model call.
 *
 * The report reads the whole photograph, and the waist and the face are each
 * a strip about a twentieth of its height. Read there, the model reported "a
 * dark, simple belt" on a man wearing none, called grey sneakers formal,
 * failed neatly trimmed beards for edges it could not see, and passed hair
 * falling over a forehead. So the request now carries, beside the photograph,
 * those areas cut out at full resolution, and asks narrow questions about
 * them: is a buckle visible, is hair on the forehead, is the beard trimmed.
 *
 * Where the areas are comes from the tablet, which has already found the
 * person's eyes, shoulders, hips and ankles in the same picture to decide when
 * to take it (bodyRegionsFromKeypoints in the frontend). A photograph without
 * them - a group, an upload, an older tablet - is asked the same questions
 * about the full photograph, and the model says where it looked.
 *
 * Mostly the answers only tighten: a row the report passed fails when the
 * close-up contradicts it, and nothing the report failed is passed, since a
 * failure may rest on something the crop does not show. The one exception is
 * the beard and moustache, which the report failed whenever it could not make
 * out an edge in a face a few dozen pixels high: there, a real face close-up
 * that shows a clean shave, light stubble or a trimmed beard is trusted over
 * it. Every row read from a close-up keeps the box it was read from, so the
 * report can show it.
 */

export const DETAIL_CHECK_VERSION = "2026-10-02.1";

/** The rows the close-up can overrule, and the region each is read from. */
const ROW_REGIONS = Object.freeze({
  M_HAIR_NEATNESS: "head",
  M_HAIR_POSITION: "head",
  M_FACIAL_HAIR: "head",
  M_MOUSTACHE: "head",
  M_SHIRT_COLLAR_TUCK: "waist",
  M_BELT: "waist",
  M_TROUSERS_TYPE: "legs",
  M_KURTA_BOTTOM: "legs",
  M_FOOTWEAR_TYPE: "feet",
});

/** Rows that also show the close-up as evidence, without being overruled by it. */
const EVIDENCE_ONLY_REGIONS = Object.freeze({
  M_HAIR_LENGTH: "head",
  M_TROUSERS_FIT_CONDITION: "legs",
  M_FOOTWEAR_CONDITION: "feet",
});

export const REGION_LABELS = Object.freeze({
  head: "Close-up of the face",
  waist: "Close-up of the waist",
  legs: "Close-up of the trousers",
  feet: "Close-up of the shoes",
});

export const REGIONS = Object.freeze(["head", "waist", "legs", "feet"]);

const CROP_LABELS = Object.freeze({ head: "FACE", waist: "WAIST", legs: "TROUSERS", feet: "SHOES" });

// ---- Boxes ------------------------------------------------------------------

/**
 * The box as it will be cropped: validated, widened by a margin so the area
 * is seen in context, and clamped to the image. Null when the box is unusable,
 * including the all-zero box that means "not found".
 */
export function paddedBox(box, { margin = 0.12, minSpan = 40 } = {}) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((value) => Number.isFinite(value))) return null;
  const [ymin, xmin, ymax, xmax] = box.map((value) => Math.max(0, Math.min(1000, value)));
  if (ymax - ymin < minSpan / 4 || xmax - xmin < minSpan / 4) return null;
  const padY = Math.max((ymax - ymin) * margin, minSpan / 2);
  const padX = Math.max((xmax - xmin) * margin, minSpan / 2);
  return [
    Math.max(0, Math.round(ymin - padY)),
    Math.max(0, Math.round(xmin - padX)),
    Math.min(1000, Math.round(ymax + padY)),
    Math.min(1000, Math.round(xmax + padX)),
  ];
}

/** Pixel rectangle for a 0-1000 box on an image of this size. */
export function boxToPixels(box, width, height) {
  const left = Math.floor((box[1] / 1000) * width);
  const top = Math.floor((box[0] / 1000) * height);
  const right = Math.ceil((box[3] / 1000) * width);
  const bottom = Math.ceil((box[2] / 1000) * height);
  return {
    left: Math.max(0, Math.min(width - 1, left)),
    top: Math.max(0, Math.min(height - 1, top)),
    width: Math.max(1, Math.min(width, right) - Math.max(0, left)),
    height: Math.max(1, Math.min(height, bottom) - Math.max(0, top)),
  };
}

/**
 * The tablet's areas, as sent with the photograph: an object of up to four
 * [ymin, xmin, ymax, xmax] boxes on a 0-1000 scale. Accepts the JSON text a
 * form field carries. Anything malformed is dropped rather than refused: the
 * areas improve the report, and attendance never depends on them.
 */
export function parseBodyRegions(raw) {
  let value = raw;
  if (typeof value === "string") {
    if (!value.trim() || value.length > 600) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const regions = {};
  for (const region of REGIONS) {
    const box = value[region];
    if (!Array.isArray(box) || box.length !== 4) continue;
    if (!box.every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 1000)) continue;
    if (!(box[2] > box[0] && box[3] > box[1])) continue;
    regions[region] = box.map((number) => Math.round(number));
  }
  return Object.keys(regions).length ? regions : null;
}

// ---- Crops ------------------------------------------------------------------

async function cropRegion(imageBuffer, width, height, box) {
  const rect = boxToPixels(box, width, height);
  const longSide = Math.max(rect.width, rect.height);
  // Small crops are enlarged so the model spends more than its minimum on
  // them; large ones are capped.
  const target = Math.min(1024, Math.max(768, longSide));
  return sharp(imageBuffer)
    .extract(rect)
    .resize({ width: target, height: target, fit: "inside", kernel: "lanczos3" })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * The close-up crops for the request, and the boxes they were cut from.
 * Never throws: a photograph that cannot be cropped is asked about whole.
 */
export async function buildCloseUps(imageBuffer, bodyRegions) {
  const regions = parseBodyRegions(bodyRegions);
  if (!regions) return { parts: [], boxes: {} };
  let width;
  let height;
  try {
    ({ width, height } = await sharp(imageBuffer).metadata());
  } catch {
    return { parts: [], boxes: {} };
  }
  if (!width || !height) return { parts: [], boxes: {} };

  const parts = [];
  const boxes = {};
  for (const region of REGIONS) {
    const box = paddedBox(regions[region]);
    if (!box) continue;
    try {
      const data = await cropRegion(imageBuffer, width, height, box);
      parts.push({ type: "input_text", text: `${CROP_LABELS[region]} close-up:` });
      parts.push({ type: "input_image", mimeType: "image/jpeg", data: data.toString("base64") });
      boxes[region] = box;
    } catch {
      // That area is judged from the photograph instead.
    }
  }
  if (parts.length) {
    parts.unshift({
      type: "input_text",
      text: "Close-up crops of the same photograph, cut where the tablet found the face, the waist, the trousers and the shoes. Use them to answer close_up.",
    });
  }
  return { parts, boxes };
}

// ---- The close_up answer ----------------------------------------------------------

const Box = z.array(z.number()).length(4);
const YES_NO_UNCLEAR = ["YES", "NO", "UNCLEAR"];
const FACIAL_HAIR = ["CLEAN_SHAVEN", "LIGHT_STUBBLE", "TRIMMED_BEARD", "UNTRIMMED_BEARD", "UNCLEAR"];
const MOUSTACHE = ["NONE", "TRIMMED_CLEAR_OF_LIP", "OVER_LIP", "UNCLEAR"];
const TROUSERS = ["FORMAL_TROUSERS", "PAYJAMA", "JEANS_OR_DENIM", "OTHER_CASUAL", "UNCLEAR"];
const FOOTWEAR = ["FORMAL_SHOES", "SNEAKERS_OR_SPORTS", "SANDALS_OR_SLIPPERS", "OTHER_CASUAL", "UNCLEAR"];

export const CloseUpAnswer = z.object({
  head_box: Box,
  waist_box: Box,
  legs_box: Box,
  feet_box: Box,
  face_assessable: z.boolean(),
  hair_messy: z.enum(YES_NO_UNCLEAR),
  hair_on_forehead: z.enum(YES_NO_UNCLEAR),
  facial_hair: z.enum(FACIAL_HAIR),
  moustache: z.enum(MOUSTACHE),
  face_observation: z.string(),
  waist_assessable: z.boolean(),
  belt_buckle_visible: z.boolean(),
  belt_strap_visible: z.boolean(),
  shirt_tucked: z.enum(YES_NO_UNCLEAR),
  waist_observation: z.string(),
  trousers_assessable: z.boolean(),
  trousers_kind: z.enum(TROUSERS),
  trousers_observation: z.string(),
  footwear_assessable: z.boolean(),
  footwear_kind: z.enum(FOOTWEAR),
  footwear_observation: z.string(),
});

const BOX_JSON_SCHEMA = { type: "array", items: { type: "integer" }, minItems: 4, maxItems: 4 };
const enumSchema = (values) => ({ type: "string", enum: [...values] });

export const CLOSE_UP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    head_box: BOX_JSON_SCHEMA,
    waist_box: BOX_JSON_SCHEMA,
    legs_box: BOX_JSON_SCHEMA,
    feet_box: BOX_JSON_SCHEMA,
    face_assessable: { type: "boolean" },
    hair_messy: enumSchema(YES_NO_UNCLEAR),
    hair_on_forehead: enumSchema(YES_NO_UNCLEAR),
    facial_hair: enumSchema(FACIAL_HAIR),
    moustache: enumSchema(MOUSTACHE),
    face_observation: { type: "string" },
    waist_assessable: { type: "boolean" },
    belt_buckle_visible: { type: "boolean" },
    belt_strap_visible: { type: "boolean" },
    shirt_tucked: enumSchema(YES_NO_UNCLEAR),
    waist_observation: { type: "string" },
    trousers_assessable: { type: "boolean" },
    trousers_kind: enumSchema(TROUSERS),
    trousers_observation: { type: "string" },
    footwear_assessable: { type: "boolean" },
    footwear_kind: enumSchema(FOOTWEAR),
    footwear_observation: { type: "string" },
  },
  required: [
    "head_box", "waist_box", "legs_box", "feet_box",
    "face_assessable", "hair_messy", "hair_on_forehead", "facial_hair", "moustache", "face_observation",
    "waist_assessable", "belt_buckle_visible", "belt_strap_visible", "shirt_tucked", "waist_observation",
    "trousers_assessable", "trousers_kind", "trousers_observation",
    "footwear_assessable", "footwear_kind", "footwear_observation",
  ],
};

/** Added to the men's instructions: how to answer close_up. */
export const CLOSE_UP_INSTRUCTIONS = `## CLOSE-UP: FACE, WAIST, TROUSERS AND SHOES (close_up)

Answer close_up from the close-up crops when the request includes them (labelled FACE, WAIST, TROUSERS and SHOES), and from the photograph otherwise. Answer only from what is visible; never assume an item is there because the rest of the outfit is formal. The hair, Facial Hair, Moustache, Belt, Shirt Collar / Tuck, trousers or Bottom Wear and Footwear Type rows must agree with these answers. Answer every field even when a row does not apply to the attire family you chose.

- head_box, waist_box, legs_box, feet_box: where in the full photograph you looked, as [ymin, xmin, ymax, xmax], integers from 0 to 1000 scaled to the photograph's height and width. head: the head and face, from the top of the hair to the chin. waist: the band around the trouser waistband where a belt is worn, hip to hip. legs: both trouser legs, waistband to hem. feet: both shoes. Use [0, 0, 0, 0] for an area that is not in the photograph.

FACE
- hair_messy: YES if the hair is uncombed, dishevelled, sticking out or visibly unset at the crown, sides or front hairline; NO if it is combed and set; UNCLEAR if you cannot tell (for example under a cap).
- hair_on_forehead: YES if any fringe, strands or locks rest on or hang over the forehead, eyebrows or eyes; NO if the forehead is clear from the hairline to the eyebrows; UNCLEAR if you cannot tell.
- facial_hair: CLEAN_SHAVEN; LIGHT_STUBBLE for short, even stubble or a negligible beard too short to have a shaped edge; TRIMMED_BEARD for a beard of any length with defined, shaped edges at the cheek and neck; UNTRIMMED_BEARD for a grown-out, uneven, patchy or ragged beard, or one straying onto the neck; UNCLEAR if you cannot tell. Light stubble and a trimmed beard are groomed.
- moustache: NONE; TRIMMED_CLEAR_OF_LIP for a moustache that stays above the lip line, however thin or light; OVER_LIP for one growing down over the lip line; UNCLEAR if you cannot tell.
- face_assessable: false if the face is out of frame, turned away, covered or too blurred to judge.
- face_observation: one sentence naming what you saw of the hair at the forehead and of the beard and moustache.

WAIST
- belt_buckle_visible: true only if you can see a belt buckle - a metal or leather fastening at the front of the waistband.
- belt_strap_visible: true only if you can see a belt strap - a band of leather or fabric running through the belt loops along the waistband, visibly separate from the trouser fabric.
- The top edge of the trousers, belt loops, a fold of shirt fabric, or a shadow at the waist are NOT a belt. Over dark trousers, look for the buckle and for the edge of a strap lying on top of the waistband; if you see neither, both are false.
- shirt_tucked: YES if the shirt hem disappears into the waistband; NO if shirt fabric hangs outside or below the waistband; UNCLEAR if you cannot tell. A kurta is not tucked: answer UNCLEAR for it.
- waist_assessable: false if the waistband is out of frame, hidden (by hands, an ID card, an untucked shirt, a kurta, a bag) or too blurred to judge.
- waist_observation: one sentence naming what you saw at the front of the waistband.

TROUSERS
- trousers_kind: JEANS_OR_DENIM for denim or jeans, including black or dark jeans (twill denim texture, rivets, contrast stitching, five-pocket styling, fading at the thighs and knees); PAYJAMA for loose or straight cotton payjama worn under a kurta; OTHER_CASUAL for joggers, track pants, cargo pants, shorts or other clearly casual trousers; FORMAL_TROUSERS for smooth dress trousers in suiting or cotton-blend fabric with a pressed or straight-falling leg; UNCLEAR when you cannot tell.
- trousers_assessable: false when the trousers are out of frame or hidden.
- trousers_observation: one sentence naming the fabric and features you saw.

SHOES
- footwear_kind: FORMAL_SHOES for leather or formal synthetic dress shoes - Oxfords, Derbys, loafers, monk straps, formal boots - with a smooth upper and a slim sole; SNEAKERS_OR_SPORTS for sneakers, trainers, running or sports shoes (mesh or knit uppers, padded collars, thick rubber or foam soles, athletic laces); SANDALS_OR_SLIPPERS for sandals, chappals, floaters, flip-flops or slippers; OTHER_CASUAL for canvas shoes or other casual footwear; UNCLEAR when you cannot tell.
- footwear_assessable: false when the shoes are out of frame or hidden.
- footwear_observation: one sentence naming the shoe type and what identified it.`;

/** The close_up answer in the shape applyDetailFindings reads. */
export function findingsFromCloseUp(closeUp) {
  return {
    face: {
      assessable: closeUp.face_assessable,
      hair_messy: closeUp.hair_messy,
      hair_on_forehead: closeUp.hair_on_forehead,
      facial_hair: closeUp.facial_hair,
      moustache: closeUp.moustache,
      observation: closeUp.face_observation,
    },
    waist: {
      assessable: closeUp.waist_assessable,
      buckle_visible: closeUp.belt_buckle_visible,
      belt_strap_visible: closeUp.belt_strap_visible,
      shirt_tucked: closeUp.shirt_tucked,
      observation: closeUp.waist_observation,
    },
    trousers: {
      assessable: closeUp.trousers_assessable,
      kind: closeUp.trousers_kind,
      observation: closeUp.trousers_observation,
    },
    footwear: {
      assessable: closeUp.footwear_assessable,
      kind: closeUp.footwear_kind,
      observation: closeUp.footwear_observation,
    },
  };
}

/**
 * The boxes to show as evidence: the crops the model was given where there
 * were crops, and otherwise where it says it looked.
 */
export function evidenceBoxes(cropBoxes, closeUp) {
  const boxes = {};
  for (const region of REGIONS) {
    boxes[region] = cropBoxes?.[region] || paddedBox(closeUp?.[`${region}_box`]) || null;
    if (!boxes[region]) delete boxes[region];
  }
  return boxes;
}

// ---- Applying ---------------------------------------------------------------

function findRow(rows, code) {
  for (const items of Object.values(rows)) {
    if (!Array.isArray(items)) continue;
    const row = items.find((item) => item?.code === code);
    if (row) return row;
  }
  return null;
}

function failRow(row, observation, reason, { notShown = false } = {}) {
  row.status = "FAIL";
  row.observation = observation.slice(0, 1000);
  row.reason = reason.slice(0, 1000);
  if (notShown) row.evidence = "NOT_SHOWN";
  row.detail_override = true;
}

function passRow(row, observation, reason) {
  row.status = "PASS";
  row.observation = observation.slice(0, 1000);
  row.reason = reason.slice(0, 1000);
  delete row.evidence;
  row.detail_override = true;
}

function confirmRow(row, observation) {
  // The reason on a PASS was the prompt's own boilerplate ("the visible
  // evidence satisfies the requirement"). What the close-up saw says more.
  row.reason = `Confirmed in the close-up: ${observation}`.slice(0, 1000);
}

/**
 * Applies the close-up findings to the report rows, in place. Pure, so the
 * rules can be tested without a model. `boxes` decides which rows show a
 * close-up as evidence; `croppedRegions` names the areas the model actually
 * saw a crop of, which the beard and moustache need before a FAIL is undone.
 * Returns the codes it failed and the codes it passed.
 */
export function applyDetailFindings(rows, findings, boxes = {}, { croppedRegions = [] } = {}) {
  const failed = [];
  const passed = [];
  const sentence = (text, fallback) => (String(text || "").trim() || fallback);

  for (const [code, region] of Object.entries({ ...ROW_REGIONS, ...EVIDENCE_ONLY_REGIONS })) {
    const row = findRow(rows, code);
    if (row && boxes[region]) {
      row.evidence_box = boxes[region];
      row.evidence_label = REGION_LABELS[region];
    }
  }

  const face = findings?.face;
  if (face?.assessable) {
    const seen = sentence(face.observation, "The hair, beard and moustache.");
    const faceCropped = croppedRegions.includes("head");

    const neatness = findRow(rows, "M_HAIR_NEATNESS");
    if (neatness?.status === "PASS" && face.hair_messy === "YES") {
      failRow(neatness, `Close-up of the face: ${seen}`, "The close-up of the face shows messy, unset hair.");
      failed.push("M_HAIR_NEATNESS");
    }

    const position = findRow(rows, "M_HAIR_POSITION");
    if (position?.status === "PASS" && face.hair_on_forehead === "YES") {
      failRow(position, `Close-up of the face: ${seen}`, "The close-up of the face shows hair resting on the forehead.");
      failed.push("M_HAIR_POSITION");
    }

    const beard = findRow(rows, "M_FACIAL_HAIR");
    if (beard?.status === "PASS" && face.facial_hair === "UNTRIMMED_BEARD") {
      failRow(beard, `Close-up of the face: ${seen}`, "The close-up of the face shows an untrimmed or unevenly shaped beard.");
      failed.push("M_FACIAL_HAIR");
    } else if (
      beard?.status === "FAIL"
      && faceCropped
      && ["CLEAN_SHAVEN", "LIGHT_STUBBLE", "TRIMMED_BEARD"].includes(face.facial_hair)
    ) {
      passRow(
        beard,
        `Close-up of the face: ${seen}`,
        face.facial_hair === "CLEAN_SHAVEN"
          ? "The close-up of the face shows a clean shave."
          : face.facial_hair === "LIGHT_STUBBLE"
            ? "The close-up of the face shows light, even stubble, which is groomed."
            : "The close-up of the face shows a beard with trimmed, defined edges.",
      );
      passed.push("M_FACIAL_HAIR");
    }

    const moustache = findRow(rows, "M_MOUSTACHE");
    if (moustache?.status === "PASS" && face.moustache === "OVER_LIP") {
      failRow(moustache, `Close-up of the face: ${seen}`, "The close-up of the face shows the moustache growing over the lip line.");
      failed.push("M_MOUSTACHE");
    } else if (
      moustache?.status === "FAIL"
      && faceCropped
      && ["NONE", "TRIMMED_CLEAR_OF_LIP"].includes(face.moustache)
    ) {
      passRow(
        moustache,
        `Close-up of the face: ${seen}`,
        face.moustache === "NONE"
          ? "The close-up of the face shows a clean-shaven upper lip."
          : "The close-up of the face shows the moustache trimmed clear of the lip line.",
      );
      passed.push("M_MOUSTACHE");
    }
  }

  const waist = findings?.waist;
  if (waist) {
    const seen = sentence(waist.observation, "The front of the waistband.");
    const belt = findRow(rows, "M_BELT");
    if (belt?.status === "PASS") {
      if (!waist.assessable) {
        failRow(
          belt,
          `Close-up of the waist: ${seen}`,
          "The close-up of the waist does not show a belt clearly enough to verify it.",
          { notShown: true },
        );
        failed.push("M_BELT");
      } else if (!waist.buckle_visible && !waist.belt_strap_visible) {
        failRow(
          belt,
          `Close-up of the waist: ${seen}`,
          "No belt buckle or belt strap is visible at the waistband in the close-up of the waist.",
        );
        failed.push("M_BELT");
      } else {
        confirmRow(belt, seen);
      }
    }

    const tuck = findRow(rows, "M_SHIRT_COLLAR_TUCK");
    if (tuck?.status === "PASS" && waist.assessable) {
      if (waist.shirt_tucked === "NO") {
        failRow(
          tuck,
          `Close-up of the waist: ${seen}`,
          "The close-up of the waist shows shirt fabric hanging outside the trousers.",
        );
        failed.push("M_SHIRT_COLLAR_TUCK");
      } else if (waist.shirt_tucked === "YES") {
        confirmRow(tuck, seen);
      }
    }
  }

  const trousers = findings?.trousers;
  if (trousers?.assessable) {
    const seen = sentence(trousers.observation, "The trouser fabric and cut.");
    const casual = trousers.kind === "JEANS_OR_DENIM" || trousers.kind === "OTHER_CASUAL";
    const reason = trousers.kind === "JEANS_OR_DENIM"
      ? "The close-up of the trousers shows jeans or denim, which are not permitted."
      : "The close-up of the trousers shows casual trousers, which are not permitted.";
    for (const code of ["M_TROUSERS_TYPE", "M_KURTA_BOTTOM"]) {
      const row = findRow(rows, code);
      if (row?.status !== "PASS") continue;
      if (casual) {
        failRow(row, `Close-up of the trousers: ${seen}`, reason);
        failed.push(code);
      } else if (
        (code === "M_TROUSERS_TYPE" && trousers.kind === "FORMAL_TROUSERS")
        || (code === "M_KURTA_BOTTOM" && (trousers.kind === "PAYJAMA" || trousers.kind === "FORMAL_TROUSERS"))
      ) {
        confirmRow(row, seen);
      }
    }
  }

  const footwear = findings?.footwear;
  const footwearRow = findRow(rows, "M_FOOTWEAR_TYPE");
  if (footwear?.assessable && footwearRow?.status === "PASS") {
    const seen = sentence(footwear.observation, "The shoes.");
    if (["SNEAKERS_OR_SPORTS", "SANDALS_OR_SLIPPERS", "OTHER_CASUAL"].includes(footwear.kind)) {
      failRow(
        footwearRow,
        `Close-up of the shoes: ${seen}`,
        footwear.kind === "SNEAKERS_OR_SPORTS"
          ? "The close-up of the shoes shows sneakers or sports shoes, not formal shoes."
          : footwear.kind === "SANDALS_OR_SLIPPERS"
            ? "The close-up of the shoes shows sandals or slippers, not formal shoes."
            : "The close-up of the shoes shows casual footwear, not formal shoes.",
      );
      failed.push("M_FOOTWEAR_TYPE");
    } else if (footwear.kind === "FORMAL_SHOES") {
      confirmRow(footwearRow, seen);
    }
  }

  return { failed, passed };
}
