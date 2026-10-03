import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  applyDetailFindings,
  boxToPixels,
  buildCloseUps,
  CLOSE_UP_INSTRUCTIONS,
  DETAIL_CHECK_VERSION,
  evidenceBoxes,
  findingsFromCloseUp,
  paddedBox,
  parseBodyRegions,
} from "../src/services/detailCheck.js";
import { checkpointSet, improvementTips, SECTION_KEYS } from "../src/checkpoints.js";

/**
 * The close-up of a man's face, waist, trousers and shoes, asked in the same
 * request as his report. The cases it exists for, from photographs reviewed
 * by the team: no belt passed as "a dark, simple belt"; slim black jeans and
 * grey sneakers passed as formal; a trimmed and a negligible beard failed for
 * edges the model could not see; hair over the forehead passed.
 */

const HEAD = [40, 400, 160, 600];
const WAIST = [480, 330, 560, 640];
const LEGS = [470, 360, 820, 620];
const FEET = [780, 340, 880, 620];
const REGIONS = { head: HEAD, waist: WAIST, legs: LEGS, feet: FEET };

/** A man's rows with every checkpoint passed, as the full-length read returned them. */
function passedRows(attire = "FORMAL") {
  const sections = checkpointSet("MALE", attire);
  return Object.fromEntries(SECTION_KEYS.map((key) => [key, sections[key].map((item) => ({
    code: item.code,
    checkpoint_name: item.name,
    status: "PASS",
    observation: "Looks fine.",
    reason: "The visible evidence satisfies the requirement.",
  }))]));
}

const row = (rows, code) => SECTION_KEYS.flatMap((key) => rows[key]).find((item) => item.code === code);

/** What the close-up of the belt photograph reports, in the reply's own shape. */
const NO_BELT_CLOSE_UP = {
  head_box: [30, 390, 170, 610],
  waist_box: [470, 320, 570, 650],
  legs_box: [460, 350, 830, 630],
  feet_box: [770, 330, 890, 630],
  face_assessable: true,
  hair_messy: "NO",
  hair_on_forehead: "NO",
  facial_hair: "LIGHT_STUBBLE",
  moustache: "TRIMMED_CLEAR_OF_LIP",
  face_observation: "Short combed hair clear of the forehead; light even stubble; thin moustache above the lip.",
  waist_assessable: true,
  belt_buckle_visible: false,
  belt_strap_visible: false,
  shirt_tucked: "YES",
  waist_observation: "The checked shirt is tucked into black trousers; no buckle or belt strap at the waistband.",
  trousers_assessable: true,
  trousers_kind: "JEANS_OR_DENIM",
  trousers_observation: "Slim black jeans with twill texture.",
  footwear_assessable: true,
  footwear_kind: "SNEAKERS_OR_SPORTS",
  footwear_observation: "Grey knit sneakers with thick rubber soles.",
};
const NO_BELT = findingsFromCloseUp(NO_BELT_CLOSE_UP);
const face = (overrides) => findingsFromCloseUp({ ...NO_BELT_CLOSE_UP, ...overrides });
const CROPPED = { croppedRegions: ["head", "waist", "legs", "feet"] };

async function photo() {
  return sharp({ create: { width: 600, height: 900, channels: 3, background: "#d8d2c4" } }).jpeg().toBuffer();
}

// -- Boxes and the tablet's regions ----------------------------------------------

test("boxes are widened for context, clamped to the image, and refused when unusable", () => {
  assert.deepEqual(paddedBox([480, 330, 560, 640]), [460, 293, 580, 677]);
  assert.deepEqual(paddedBox([0, 0, 1000, 1000]), [0, 0, 1000, 1000]);
  assert.deepEqual(paddedBox([-50, -10, 1200, 900]), [0, 0, 1000, 1000]);
  assert.equal(paddedBox([0, 0, 0, 0]), null, "a not-found box");
  assert.equal(paddedBox([500, 500, 503, 900]), null, "a sliver");
  assert.equal(paddedBox([1, 2, 3]), null);
  assert.equal(paddedBox(null), null);
  assert.deepEqual(boxToPixels([500, 250, 600, 750], 1000, 2000), { left: 250, top: 1000, width: 500, height: 200 });
});

test("the tablet's regions are read from the form field, and anything malformed is dropped", () => {
  assert.deepEqual(parseBodyRegions(JSON.stringify(REGIONS)), REGIONS);
  assert.deepEqual(parseBodyRegions({ waist: [480.4, 330.6, 560, 640] }), { waist: [480, 331, 560, 640] });
  assert.deepEqual(parseBodyRegions({ waist: WAIST, legs: [800, 0, 400, 100], feet: [1, 2, 3, 4000] }), { waist: WAIST });
  for (const bad of [null, "", "not json", "[1,2,3,4]", JSON.stringify({ waist: "x" }), "x".repeat(700), 42]) {
    assert.equal(parseBodyRegions(bad), null, String(bad).slice(0, 20));
  }
});

// -- Waist, trousers and shoes ---------------------------------------------------------

test("a belt the close-up cannot find fails, and so do jeans and sneakers", () => {
  const rows = passedRows();
  const { failed, passed } = applyDetailFindings(rows, NO_BELT, REGIONS, CROPPED);

  assert.deepEqual(failed.sort(), ["M_BELT", "M_FOOTWEAR_TYPE", "M_TROUSERS_TYPE"]);
  assert.deepEqual(passed, []);
  const belt = row(rows, "M_BELT");
  assert.equal(belt.status, "FAIL");
  assert.match(belt.observation, /^Close-up of the waist: .*no buckle or belt strap/);
  assert.equal(belt.reason, "No belt buckle or belt strap is visible at the waistband in the close-up of the waist.");
  assert.equal(belt.evidence, undefined, "a missing belt is a clothing failure, not a framing one");
  assert.match(row(rows, "M_TROUSERS_TYPE").reason, /jeans or denim/);
  assert.match(row(rows, "M_FOOTWEAR_TYPE").reason, /sneakers or sports shoes/);
  assert.match(row(rows, "M_SHIRT_COLLAR_TUCK").reason, /^Confirmed in the close-up: The checked shirt is tucked/);

  const tips = improvementTips(rows);
  assert.ok(tips.includes("Wear a formal belt with your trousers."));
  assert.ok(tips.includes("Replace jeans with formal trousers."));
  assert.ok(tips.includes("Wear clean formal shoes instead of casual footwear."));
});

test("every row read from a close-up carries the box it was read from", () => {
  const rows = passedRows();
  applyDetailFindings(rows, NO_BELT, REGIONS, CROPPED);
  for (const [code, box, label] of [
    ["M_HAIR_NEATNESS", HEAD, "Close-up of the face"],
    ["M_HAIR_POSITION", HEAD, "Close-up of the face"],
    ["M_HAIR_LENGTH", HEAD, "Close-up of the face"],
    ["M_FACIAL_HAIR", HEAD, "Close-up of the face"],
    ["M_MOUSTACHE", HEAD, "Close-up of the face"],
    ["M_SHIRT_COLLAR_TUCK", WAIST, "Close-up of the waist"],
    ["M_BELT", WAIST, "Close-up of the waist"],
    ["M_TROUSERS_TYPE", LEGS, "Close-up of the trousers"],
    ["M_TROUSERS_FIT_CONDITION", LEGS, "Close-up of the trousers"],
    ["M_FOOTWEAR_TYPE", FEET, "Close-up of the shoes"],
    ["M_FOOTWEAR_CONDITION", FEET, "Close-up of the shoes"],
  ]) {
    assert.deepEqual(row(rows, code).evidence_box, box, code);
    assert.equal(row(rows, code).evidence_label, label, code);
  }
  assert.equal(row(rows, "M_SHIRT_TYPE")?.evidence_box, undefined, "rows the close-up did not read get no box");
});

test("for the attire, the close-up only tightens: a belt it sees passes, and a failure is never passed", () => {
  const rows = passedRows();
  row(rows, "M_TROUSERS_TYPE").status = "FAIL";
  row(rows, "M_TROUSERS_TYPE").reason = "Jeans.";
  const formal = face({
    belt_buckle_visible: true,
    belt_strap_visible: true,
    waist_observation: "Black leather belt with a silver buckle.",
    trousers_kind: "FORMAL_TROUSERS",
    footwear_kind: "FORMAL_SHOES",
  });
  assert.deepEqual(applyDetailFindings(rows, formal, REGIONS, CROPPED), { failed: [], passed: [] });
  assert.equal(row(rows, "M_BELT").status, "PASS");
  assert.equal(row(rows, "M_BELT").reason, "Confirmed in the close-up: Black leather belt with a silver buckle.");
  assert.equal(row(rows, "M_TROUSERS_TYPE").status, "FAIL", "formal in the close-up does not overturn a failure");
  assert.equal(row(rows, "M_TROUSERS_TYPE").reason, "Jeans.");
});

test("a waist the close-up cannot see fails the belt as not shown, but leaves the tuck alone", () => {
  const rows = passedRows();
  applyDetailFindings(rows, face({
    waist_assessable: false,
    shirt_tucked: "UNCLEAR",
    waist_observation: "Both hands and an ID card cover the waistband.",
  }), REGIONS, CROPPED);
  const belt = row(rows, "M_BELT");
  assert.equal(belt.status, "FAIL");
  assert.equal(belt.evidence, "NOT_SHOWN");
  assert.ok(improvementTips(rows).some((tip) => /full-length photograph that shows your waist/.test(tip)));
  assert.equal(row(rows, "M_SHIRT_COLLAR_TUCK").status, "PASS");
});

test("a belt seen in the close-up passes even when an ID card covers part of the waist", () => {
  // Simhadri, 3 Oct: black belt and silver buckle in plain view, failed as
  // "not shown" because the close-up called the waist partly obscured.
  for (const seen of [{ belt_buckle_visible: true }, { belt_strap_visible: true }]) {
    const rows = passedRows();
    const result = applyDetailFindings(rows, face({
      waist_assessable: false,
      shirt_tucked: "UNCLEAR",
      waist_observation: "A black belt with a silver buckle; the waistband is partially obscured by the shirt and ID card lanyard.",
      ...seen,
    }), REGIONS, CROPPED);
    const belt = row(rows, "M_BELT");
    assert.equal(belt.status, "PASS");
    assert.equal(belt.evidence, undefined);
    assert.match(belt.reason, /^Confirmed in the close-up: A black belt with a silver buckle/);
    assert.ok(!result.failed.includes("M_BELT"));
    assert.ok(!improvementTips(rows).some((tip) => /shows your waist/.test(tip)));
  }

  // A waist with no belt on it still fails, seen or hidden.
  const none = passedRows();
  applyDetailFindings(none, face(), REGIONS, CROPPED);
  assert.equal(row(none, "M_BELT").status, "FAIL");
  assert.equal(row(none, "M_BELT").reason, "No belt buckle or belt strap is visible at the waistband in the close-up of the waist.");
});

test("the close-up is told an ID card above the waistband does not hide it", () => {
  assert.match(CLOSE_UP_INSTRUCTIONS, /Answer both from whatever part of the waistband you can see, even when something covers another part of it/);
  assert.match(CLOSE_UP_INSTRUCTIONS, /waist_assessable: false only if the front of the waistband is out of frame, mostly covered \(by hands, an untucked shirt, a kurta, a bag\)/);
  assert.match(CLOSE_UP_INSTRUCTIONS, /An ID card or lanyard hanging above the waistband, or across only part of it, does not make it unassessable/);
  assert.doesNotMatch(CLOSE_UP_INSTRUCTIONS, /hidden \(by hands, an ID card/);
});

test("an untucked shirt fails the tuck; an unclear one does not", () => {
  const untucked = passedRows();
  applyDetailFindings(untucked, face({ belt_buckle_visible: true, shirt_tucked: "NO" }));
  assert.equal(row(untucked, "M_SHIRT_COLLAR_TUCK").status, "FAIL");
  assert.equal(row(untucked, "M_BELT").status, "PASS");

  const unclear = passedRows();
  applyDetailFindings(unclear, face({ belt_buckle_visible: true, shirt_tucked: "UNCLEAR" }));
  assert.equal(row(unclear, "M_SHIRT_COLLAR_TUCK").status, "PASS");
});

// -- The face ----------------------------------------------------------------------------

test("hair over the forehead and messy hair fail, as the full-length read missed", () => {
  const rows = passedRows();
  const { failed } = applyDetailFindings(rows, face({
    hair_messy: "YES",
    hair_on_forehead: "YES",
    face_observation: "Uncombed hair sticking out at the crown, with strands falling over the forehead.",
  }), REGIONS, CROPPED);
  assert.ok(failed.includes("M_HAIR_NEATNESS") && failed.includes("M_HAIR_POSITION"));
  assert.equal(row(rows, "M_HAIR_NEATNESS").reason, "The close-up of the face shows messy, unset hair.");
  assert.equal(row(rows, "M_HAIR_POSITION").reason, "The close-up of the face shows hair resting on the forehead.");
  const tips = improvementTips(rows);
  assert.ok(tips.includes("Comb your hair neatly before the session."));
  assert.ok(tips.includes("Set your hair back or up so your forehead is fully clear."));
});

test("a forehead the full-length read failed passes on a real face close-up that shows it clear", () => {
  const failedPosition = () => {
    const rows = passedRows();
    Object.assign(row(rows, "M_HAIR_POSITION"), {
      status: "FAIL",
      observation: "Several strands of hair are resting on the forehead and obscuring the upper part of the eyebrows.",
      reason: "Hair is falling across the forehead and eyes, violating the standard.",
    });
    Object.assign(row(rows, "M_HAIR_NEATNESS"), { status: "FAIL", reason: "Dishevelled at the crown." });
    return rows;
  };
  const clear = face({
    hair_on_forehead: "NO",
    hair_messy: "NO",
    face_observation: "Curly hair set up and back; the forehead is clear from the hairline to the eyebrows.",
  });

  const rows = failedPosition();
  const result = applyDetailFindings(rows, clear, REGIONS, CROPPED);
  assert.ok(result.passed.includes("M_HAIR_POSITION"));
  const position = row(rows, "M_HAIR_POSITION");
  assert.equal(position.status, "PASS");
  assert.equal(position.observation, "Close-up of the face: Curly hair set up and back; the forehead is clear from the hairline to the eyebrows.");
  assert.equal(position.reason, "The close-up of the face shows the forehead clear of hair from the hairline to the eyebrows.");
  assert.ok(!improvementTips(rows).includes("Set your hair back or up so your forehead is fully clear."));
  // Messy hair the report saw is never passed by the close-up.
  assert.equal(row(rows, "M_HAIR_NEATNESS").status, "FAIL");
  assert.equal(row(rows, "M_HAIR_NEATNESS").reason, "Dishevelled at the crown.");
  assert.ok(!result.passed.includes("M_HAIR_NEATNESS"));

  // Without a real face crop, or with an unclear answer, the failure stands.
  for (const [findings, options] of [
    [clear, { croppedRegions: ["waist", "legs", "feet"] }],
    [face({ hair_on_forehead: "UNCLEAR" }), CROPPED],
    [face({ face_assessable: false, hair_on_forehead: "NO" }), CROPPED],
  ]) {
    const kept = failedPosition();
    applyDetailFindings(kept, findings, REGIONS, options);
    assert.equal(row(kept, "M_HAIR_POSITION").status, "FAIL");
  }
});

test("the face close-up is told curls at the hairline are not on the forehead, and shaped curls are not messy", () => {
  assert.match(CLOSE_UP_INSTRUCTIONS, /Curls or waves whose front edge sits at the hairline, and hair at the temples or beside the ears, are not on the forehead\./);
  assert.match(CLOSE_UP_INSTRUCTIONS, /Natural curly or wavy hair that is shaped and under control is NO; curly hair that is uncombed or sticking out is YES\./);
});

test("a trimmed or light beard the full-length read failed passes on a real face close-up", () => {
  for (const [facialHair, reason] of [
    ["TRIMMED_BEARD", "The close-up of the face shows a short, even beard or one with trimmed, defined edges."],
    ["LIGHT_STUBBLE", "The close-up of the face shows light, even stubble, which is groomed."],
    ["CLEAN_SHAVEN", "The close-up of the face shows a clean shave."],
  ]) {
    const rows = passedRows();
    row(rows, "M_FACIAL_HAIR").status = "FAIL";
    row(rows, "M_FACIAL_HAIR").reason = "The beard does not have a clearly defined edge.";
    row(rows, "M_MOUSTACHE").status = "FAIL";
    const { passed } = applyDetailFindings(rows, face({ facial_hair: facialHair }), REGIONS, CROPPED);
    assert.deepEqual(passed.sort(), ["M_FACIAL_HAIR", "M_MOUSTACHE"], facialHair);
    assert.equal(row(rows, "M_FACIAL_HAIR").status, "PASS");
    assert.equal(row(rows, "M_FACIAL_HAIR").reason, reason);
    assert.equal(row(rows, "M_MOUSTACHE").reason, "The close-up of the face shows the moustache trimmed clear of the lip line.");
    assert.ok(!improvementTips(rows).includes("Trim and shape your beard, or shave clean."));
  }
});

test("without a real face crop a beard failure stands, and an untrimmed beard always fails", () => {
  const uncropped = passedRows();
  row(uncropped, "M_FACIAL_HAIR").status = "FAIL";
  const result = applyDetailFindings(uncropped, face({ facial_hair: "TRIMMED_BEARD" }), REGIONS, { croppedRegions: ["waist"] });
  assert.equal(row(uncropped, "M_FACIAL_HAIR").status, "FAIL", "the model's own box is evidence, not a crop");
  assert.deepEqual(result.passed, []);

  const untrimmed = passedRows();
  applyDetailFindings(untrimmed, face({ facial_hair: "UNTRIMMED_BEARD", moustache: "OVER_LIP" }));
  assert.equal(row(untrimmed, "M_FACIAL_HAIR").status, "FAIL");
  assert.equal(row(untrimmed, "M_MOUSTACHE").status, "FAIL");

  const hidden = passedRows();
  row(hidden, "M_FACIAL_HAIR").status = "FAIL";
  applyDetailFindings(hidden, face({ face_assessable: false, hair_messy: "YES" }), REGIONS, CROPPED);
  assert.equal(row(hidden, "M_FACIAL_HAIR").status, "FAIL", "an unassessable face changes nothing");
  assert.equal(row(hidden, "M_HAIR_NEATNESS").status, "PASS");
});

// -- A kurta ---------------------------------------------------------------------------

test("a kurta's bottom wear fails for jeans and is confirmed for payjama; it has no beard or belt rows", () => {
  const jeans = passedRows("KURTA_PAJAMA");
  const result = applyDetailFindings(jeans, NO_BELT, REGIONS, CROPPED);
  assert.ok(result.failed.includes("M_KURTA_BOTTOM"));
  assert.match(row(jeans, "M_KURTA_BOTTOM").reason, /jeans or denim/);
  assert.equal(row(jeans, "M_BELT"), undefined);
  assert.equal(row(jeans, "M_FACIAL_HAIR"), undefined);

  const payjama = passedRows("KURTA_PAJAMA");
  applyDetailFindings(payjama, face({ trousers_kind: "PAYJAMA", trousers_observation: "White cotton payjama." }), REGIONS, CROPPED);
  assert.equal(row(payjama, "M_KURTA_BOTTOM").status, "PASS");
  assert.equal(row(payjama, "M_KURTA_BOTTOM").reason, "Confirmed in the close-up: White cotton payjama.");
});

// -- Evidence and crops ---------------------------------------------------------------------

test("evidence shows the crops the model was given, or else where it says it looked", () => {
  const crops = { waist: paddedBox(WAIST) };
  const boxes = evidenceBoxes(crops, NO_BELT_CLOSE_UP);
  assert.deepEqual(boxes.waist, paddedBox(WAIST), "the crop it actually read");
  assert.deepEqual(boxes.legs, paddedBox(NO_BELT_CLOSE_UP.legs_box), "no crop: its own box");
  assert.deepEqual(boxes.head, paddedBox(NO_BELT_CLOSE_UP.head_box));
  const none = evidenceBoxes({}, { ...NO_BELT_CLOSE_UP, feet_box: [0, 0, 0, 0] });
  assert.equal(none.feet, undefined, "nothing to show for an area it did not find");
});

test("the tablet's regions become labelled full-resolution crops for the request", async () => {
  const { parts, boxes } = await buildCloseUps(await photo(), JSON.stringify(REGIONS));
  const images = parts.filter((part) => part.type === "input_image");
  assert.equal(images.length, 4);
  assert.deepEqual(parts.filter((part) => part.type === "input_text").map((part) => part.text).slice(1), [
    "FACE close-up:", "WAIST close-up:", "TROUSERS close-up:", "SHOES close-up:",
  ]);
  for (const image of images) {
    const meta = await sharp(Buffer.from(image.data, "base64")).metadata();
    assert.equal(meta.format, "jpeg");
    assert.ok(Math.max(meta.width, meta.height) >= 768, "small crops are enlarged");
  }
  assert.deepEqual(boxes, { head: paddedBox(HEAD), waist: paddedBox(WAIST), legs: paddedBox(LEGS), feet: paddedBox(FEET) });

  assert.deepEqual(await buildCloseUps(await photo(), null), { parts: [], boxes: {} });
  assert.deepEqual(await buildCloseUps(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), REGIONS), { parts: [], boxes: {} });
});

// -- One request -------------------------------------------------------------------------

function stubGemini(responses) {
  const GEMINI_ENV = ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_TIMEOUT_MS", "GEMINI_MAX_RETRIES", "GEMINI_EXPLICIT_CACHE"];
  const original = Object.fromEntries(GEMINI_ENV.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-only-gemini-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";
  process.env.GEMINI_TIMEOUT_MS = "120000";
  process.env.GEMINI_MAX_RETRIES = "0";
  process.env.GEMINI_EXPLICIT_CACHE = "false";
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    const next = responses[bodies.length - 1];
    if (next?.status) {
      return new Response(JSON.stringify({ error: { message: next.message } }), { status: next.status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(next) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    bodies,
    restore() {
      globalThis.fetch = originalFetch;
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

function maleReport(closeUp, sections = checkpointSet("MALE", "FORMAL"), extra = {}) {
  const report = {
    subject_visible: true,
    image_quality: "ADEQUATE",
    ai_summary: "Formal outfit.",
    visible_regions: { face: "VISIBLE", upper_body: "VISIBLE", lower_body: "VISIBLE", footwear: "VISIBLE", id_card: "VISIBLE", hands: "VISIBLE" },
    ...(closeUp === undefined ? {} : { close_up: closeUp }),
    ...extra,
  };
  for (const key of SECTION_KEYS) {
    if (!sections[key].length) continue;
    report[key] = Object.fromEntries(sections[key].map((item) => [item.code, { status: "PASS", observation: "Fine.", reason: "The visible evidence satisfies the requirement." }]));
  }
  return report;
}

const images = (body) => body.contents[0].parts.filter((part) => part.inlineData).length;

test("a man's report is one request carrying the photograph and the four close-ups", async () => {
  const stub = stubGemini([maleReport(NO_BELT_CLOSE_UP)]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(await photo(), "image/jpeg", "MALE", undefined, { bodyRegions: REGIONS });
    assert.equal(stub.bodies.length, 1, "one model call per photograph");
    assert.equal(images(stub.bodies[0]), 5, "the photograph and four crops");
    assert.match(stub.bodies[0].systemInstruction.parts[0].text, /## CLOSE-UP: FACE, WAIST, TROUSERS AND SHOES/);
    assert.ok(stub.bodies[0].generationConfig.responseJsonSchema.required.includes("close_up"));

    assert.equal(result.overall_status, "NON_COMPLIANT", "the belt the report invented no longer passes");
    assert.equal(result.attire_type, "FORMAL");
    assert.deepEqual(result.detail_check, {
      version: DETAIL_CHECK_VERSION,
      crops: ["head", "waist", "legs", "feet"],
      overridden: ["M_BELT", "M_TROUSERS_TYPE", "M_FOOTWEAR_TYPE"],
    });
    const belt = result.attire_check.find((item) => item.code === "M_BELT");
    assert.equal(belt.status, "FAIL");
    assert.deepEqual(belt.evidence_box, paddedBox(WAIST), "the crop it read, to show in the report");
  } finally {
    stub.restore();
  }
});

test("without the tablet's regions it is still one request, asked about the photograph", async () => {
  const stub = stubGemini([maleReport(NO_BELT_CLOSE_UP)]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(await photo(), "image/jpeg", "MALE");
    assert.equal(stub.bodies.length, 1);
    assert.equal(images(stub.bodies[0]), 1, "the photograph alone");
    assert.deepEqual(result.detail_check.crops, []);
    assert.equal(result.attire_check.find((item) => item.code === "M_BELT").status, "FAIL");
    assert.deepEqual(result.attire_check.find((item) => item.code === "M_BELT").evidence_box, paddedBox(NO_BELT_CLOSE_UP.waist_box));
  } finally {
    stub.restore();
  }
});

test("a malformed close-up is ignored and the report stands", async () => {
  const stub = stubGemini([maleReport({ waist_box: [1, 2, 3] })]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(await photo(), "image/jpeg", "MALE", undefined, { bodyRegions: REGIONS });
    assert.equal(stub.bodies.length, 1);
    assert.equal(result.overall_status, "COMPLIANT");
    assert.equal(result.detail_check, undefined);
  } finally {
    stub.restore();
  }
});
