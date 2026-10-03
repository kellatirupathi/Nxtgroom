import { z } from "zod";

export const BLAZER_UNDER = Object.freeze(["FORMAL_SHIRT", "T_SHIRT_OR_POLO", "OTHER", "NOT_VISIBLE", "NONE"]);

export const BlazerAnswer = z.object({
  worn: z.boolean(),
  under: z.enum(BLAZER_UNDER),
  observation: z.string(),
});

export const BLAZER_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    worn: { type: "boolean" },
    under: { type: "string", enum: [...BLAZER_UNDER] },
    observation: { type: "string" },
  },
  required: ["worn", "under", "observation"],
});

export const BLAZER_INSTRUCTIONS = `### BLAZER OR SUIT (blazer)
Report in blazer whether a blazer or a suit jacket is worn over the top - any colour or pattern, buttoned or open, by a man or a woman. A cardigan, sweater, hoodie, waistcoat, shawl or casual jacket is not a blazer.
- worn: true only when a blazer or suit jacket is clearly being worn; otherwise false.
- under: what shows under it at the chest and collar. FORMAL_SHIRT for a collared shirt or a formal blouse; T_SHIRT_OR_POLO when a t-shirt, a polo or another casual collarless top is clearly visible; OTHER for a kurti, a saree blouse or anything else; NOT_VISIBLE when it cannot be seen; NONE when no blazer is worn.
- observation: one sentence naming the jacket and what is under it, or "No blazer or suit jacket." when none is worn.
A blazer is optional and never a failure. When one is worn it covers the shirt and the waist, and the shirt and belt checkpoints are settled from this answer: still return them, and judge every other checkpoint as usual.`;

const SHIRT_OBSERVATION = "Wearing a blazer or suit over the shirt.";
const TOP_OBSERVATION = "Wearing a blazer or suit over the top.";

const MEN_COVERED = Object.freeze({
  M_SHIRT_TYPE: "Not assessed: a blazer or suit is worn over the shirt.",
  M_SHIRT_FIT: "Not assessed: a blazer or suit is worn over the shirt.",
  M_SHIRT_CONDITION: "Not assessed: a blazer or suit is worn over the shirt.",
  M_SHIRT_COLLAR_TUCK: "Not assessed: the blazer covers the shirt and the waist.",
  M_BELT: "Not assessed: the blazer covers the waist and the belt.",
});

const WOMEN_COVERED = Object.freeze({
  W_FORMAL_TOP: "Not assessed: a blazer or suit is worn over the top.",
  W_FORMAL_TOP_FIT_CONDITION: "Not assessed: a blazer or suit is worn over the top.",
});

const TOP_TYPE_CODES = Object.freeze({ MALE: "M_SHIRT_TYPE", FEMALE: "W_FORMAL_TOP" });

export const BLAZER_ROW_NAME = "Blazer / Suit";

function findRow(rows, code) {
  for (const items of Object.values(rows)) {
    if (!Array.isArray(items)) continue;
    const row = items.find((item) => item?.code === code);
    if (row) return row;
  }
  return null;
}

export function blazerWorn(answer) {
  const parsed = BlazerAnswer.safeParse(answer);
  return parsed.success && parsed.data.worn === true;
}

export function applyBlazer(rows, { gender, attireType, answer }) {
  const parsed = BlazerAnswer.safeParse(answer);
  if (!parsed.success || !parsed.data.worn) return null;
  const blazer = parsed.data;
  const female = gender === "FEMALE";
  const formal = attireType === "FORMAL";
  const casualUnder = blazer.under === "T_SHIRT_OR_POLO";
  const seen = String(blazer.observation || "").trim() || "A blazer or suit jacket is worn.";
  const passed = [];
  const failed = [];

  const pass = (row, observation, reason) => {
    row.status = "PASS";
    row.observation = observation;
    row.reason = reason;
    delete row.evidence;
    row.blazer_override = true;
    passed.push(row.code);
  };

  if (formal) {
    for (const [code, reason] of Object.entries(female ? WOMEN_COVERED : MEN_COVERED)) {
      const row = findRow(rows, code);
      if (!row) continue;
      if (casualUnder && code === TOP_TYPE_CODES[female ? "FEMALE" : "MALE"]) {
        row.status = "FAIL";
        row.observation = seen.slice(0, 1000);
        row.reason = female
          ? "A t-shirt or polo is worn under the blazer; wear a formal blouse or shirt under it."
          : "A t-shirt or polo is worn under the blazer; wear a formal shirt under it.";
        delete row.evidence;
        row.blazer_override = true;
        failed.push(code);
        continue;
      }
      pass(row, female ? TOP_OBSERVATION : SHIRT_OBSERVATION, reason);
    }
    const attire = female ? findRow(rows, "W_FORMAL_ATTIRE_TYPE") : null;
    if (attire && !casualUnder) {
      pass(attire, seen.slice(0, 1000), "A blazer or suit is worn over the shirt or blouse and trousers: accepted as a formal suit.");
    }
  }

  if (!Array.isArray(rows.attire_check)) rows.attire_check = [];
  rows.attire_check.push({
    code: female ? "W_BLAZER" : "M_BLAZER",
    checkpoint_name: BLAZER_ROW_NAME,
    status: "PASS",
    observation: seen.slice(0, 1000),
    reason: formal
      ? `Optional. A blazer or suit is worn, so the ${female ? "top" : "shirt and belt"} checkpoints are passed.`
      : "Optional. A blazer or suit is worn over the outfit.",
  });

  const remark = casualUnder
    ? "Wearing a blazer over a t-shirt or polo."
    : formal
      ? `Wearing a blazer or suit over the ${female ? "top" : "shirt"}; the ${female ? "top" : "shirt and belt"} checks are passed.`
      : "Wearing a blazer or suit.";
  return { worn: true, under: blazer.under, passed, failed, remark };
}
