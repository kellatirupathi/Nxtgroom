/**
 * The fixed checkpoint sets every evaluation must return.
 *
 * The model used to invent both the names and the count, so two photos of the
 * same person produced different reports and nothing was comparable. These
 * tables are the contract: the prompt is generated from them and the response
 * is validated against them, so a missing row is a rejected response rather
 * than a judgement the model was allowed to make.
 *
 * Codes are stable and internal. Only the name reaches the report.
 *
 * A checkpoint marked `informational` is reported but never scored. It exists
 * because some things are worth recording and are not rules — a watch is
 * optional, so failing someone for wearing one, or for not, would be inventing
 * a standard nobody set.
 */

/**
 * One row, for everyone.
 *
 * The card is either being worn or it is not. Chest height, lanyard colour,
 * readability and wear were each their own row, and a check-in photo rarely
 * resolves any of them — they mostly produced N/A, or a confident guess about
 * a card too small to read.
 */
export const ID_CARD_CHECKS = [
  {
    code: "ID_PRESENT",
    name: "ID Card Present",
    rule: "An instructor ID card is visibly being worn around the neck at chest level using the official lanyard, PASS when a card is visible, FAIL when the chest and upper body are visible and no card is present , if it's not worn around the neck (e.g., clipped to a belt). N/A when the framing does not show enough of the upper body to tell. Do not judge the card's position, condition, readability or lanyard.",
  },
];

/**
 * Hair rules, shared wording across both dress codes.
 *
 * Hair across the face is the failure that matters and the one the reports
 * kept missing, so it is its own row rather than folded into neatness. Colour
 * is not judged at all.
 */
export const MEN_GROOMING_CHECKS = [
  { code: "M_HAIR_NEATNESS", name: "Hair Neatness", rule: "Hair is combed and looks deliberately maintained. FAIL clearly messy, uncombed, dishevelled or uncontrolled hair. Do not judge hair colour." },
  { code: "M_HAIR_POSITION", name: "Hair Position / Away From Face", rule: "Hair is kept back and away from the face. FAIL when strands clearly fall across the forehead, eyes or face. Hair should stay behind or away from the face throughout a session." },
  { code: "M_HAIR_LENGTH", name: "Hair Length", rule: "Hair does not extend past the shirt collar." },
  { code: "M_FACIAL_HAIR", name: "Facial Hair", rule: "Either cleanly shaven, or a beard that is trimmed and shaped with defined edges. FAIL a messy, overgrown or unshaped beard, and FAIL a neck beard where clearly visible. Judge all of this together rather than as separate rows." },
  { code: "M_MOUSTACHE", name: "Moustache", rule: "Neatly maintained and trimmed clear of the lip line. FAIL a clearly excessive or untidy moustache." },
];

export const MEN_ATTIRE_CHECKS = [
  { code: "M_ATTIRE_TYPE", name: "Attire Type", rule: "Classifies the overall visible combination. A formal full-sleeve shirt with formal trousers is expected." },
  { code: "M_SHIRT_TYPE", name: "Shirt Type", rule: "A formal collared FULL-SLEEVE shirt is required. FAIL a t-shirt, a polo shirt, a casual shirt, and FAIL a half-sleeve or short-sleeve shirt of any kind. Sleeve length is part of this checkpoint: say explicitly when sleeves are short." },
  { code: "M_SHIRT_FIT", name: "Shirt Fit", rule: "FAIL major pulling at the buttons, severe tightness or heavy bunching. Ordinary folds are fine." },
  { code: "M_SHIRT_CONDITION", name: "Shirt Condition", rule: "Covers cleanliness, stains, tears and heavy wrinkling or an obviously unpressed shirt, judged together." },
  { code: "M_SHIRT_COLLAR_TUCK", name: "Shirt Collar / Tuck", rule: "Covers collar presentation, no more than one button open, and tucking. If the waist is not visible, say so rather than guessing." },
  { code: "M_TROUSERS_TYPE", name: "Trousers Type", rule: "Formal trousers. FAIL jeans, denim, joggers and obviously casual trousers." },
  { code: "M_TROUSERS_FIT_CONDITION", name: "Trousers Fit & Condition", rule: "Covers fit, visible condition, tears or fraying, heavy creasing and hem length together." },
  { code: "M_BELT", name: "Belt", rule: "Presence and formality, judged only when the waist is clearly visible. Otherwise N/A." },
];

export const MEN_ACCESSORIES_CHECKS = [
  { code: "M_RINGS", name: "Rings", rule: "At most one visible ring per hand. N/A when the hands are not visible." },
  { code: "M_CHAIN", name: "Chain / Necklace", rule: "No distracting chain visible above the collar." },
  { code: "M_DISTRACTING_ACCESSORIES", name: "Bracelets / Distracting Accessories", rule: "Bracelets and other clearly distracting statement pieces, judged together." },
  { code: "M_EYEWEAR", name: "Eyewear", rule: "Simple and professional eyewear is permitted. Wearing no eyewear is also PASS. FAIL if the instructor is wearing sunglasses, tinted glasses indoors, or overly fancy/distracting frames." },
  {
    code: "M_WATCH",
    name: "Watch",
    informational: true,
    rule: "Record whether a watch is visible, and nothing more. A watch is optional, so this never affects compliance. Use PASS with an observation stating what is visible, or N/A when the wrists are not visible. Never FAIL.",
  },
];

export const MEN_FOOTWEAR_CHECKS = [
  { code: "M_FOOTWEAR_TYPE", name: "Footwear Type", rule: "Formal leather or formal synthetic shoes pass — Oxfords, Derbys, leather loafers, monk straps, formal boots. FAIL sneakers, sports shoes, sandals, chappals, floaters and casual driving shoes." },
  { code: "M_FOOTWEAR_CONDITION", name: "Footwear Condition", rule: "Covers cleanliness, polish, visible damage and worn-out state together." },
];

export const WOMEN_GROOMING_CHECKS = [
  { code: "W_HAIR_NEATNESS", name: "Hair Neatness", rule: "Hair is neat and deliberately maintained, whether tied, braided, pinned or worn loose. FAIL clearly messy, uncontrolled or dishevelled hair. Do not judge hair colour." },
  { code: "W_HAIR_POSITION", name: "Hair Position / Away From Face", rule: "Hair is kept back, away from the face, and preferably toward the back of the head. FAIL when strands clearly fall across the front of the face, the forehead or the eyes. Loose hair is acceptable only while it stays controlled and off the face." },
  { code: "W_HAIR_ACCESSORIES", name: "Hair Accessories", rule: "Plain, simple accessories. FAIL only clearly oversized or decorative ones." },
  { code: "W_MAKEUP", name: "Makeup", rule: "Natural, professional appearance judged as one thing. If lighting or colour rendering is unreliable, answer N/A rather than guessing." },
  { code: "W_NAILS", name: "Nails", rule: "Trimmed and clean. N/A whenever the hands are not clearly visible, which is most photographs." },
];

/**
 * Saree checkpoints.
 *
 * Split so that how the saree is worn is judged separately from what it is
 * made of — an immaculate fabric draped badly is a different finding from a
 * creased one draped well, and one row could not say both.
 */
export const SAREE_ATTIRE_CHECKS = [
  { code: "W_SAREE_ATTIRE_TYPE", name: "Attire Type", rule: "Confirms a saree is the visible garment." },
  { code: "W_SAREE_WEARING", name: "Saree Wearing / Drape", rule: "The saree is properly and professionally draped: secure at the waist and shoulder, sitting where it should, not slipping or loosely thrown on. FAIL a saree that is visibly worn incorrectly or carelessly." },
  { code: "W_SAREE_PLEATS_PALLU", name: "Saree Pleats & Pallu", rule: "Pleats are even and tidy, and the pallu is pinned or managed neatly at an appropriate length. FAIL bunched or disordered pleats, and FAIL a pallu that hangs loose, drags or is left unmanaged." },
  { code: "W_SAREE_BLOUSE", name: "Blouse Fit & Coverage", rule: "Covers fit, neckline and sleeve coverage together. A SLEEVELESS BLOUSE IS NOT PERMITTED and is always a FAIL — say explicitly that the blouse is sleeveless. Also FAIL exposed straps or visible safety pins." },
  { code: "W_SAREE_FABRIC", name: "Saree Fabric / Condition", rule: "Covers the fabric and the state it is in: professional material, not sheer or transparent, and clean, pressed and undamaged. FAIL visible stains, tears, fraying or heavy creasing." },
  { code: "W_SAREE_PRESENTATION", name: "Saree Overall Presentation", rule: "Whether the saree reads as professional overall — the impression the whole outfit gives in a teaching setting, once drape, fabric and blouse are each accounted for." },
];

export const KURTI_ATTIRE_CHECKS = [
  { code: "W_KURTI_ATTIRE_TYPE", name: "Attire Type", rule: "Confirms a kurti is the visible garment." },
  { code: "W_KURTI_FIT_LENGTH", name: "Kurti Fit & Length", rule: "Covers fit, length and side slit height together." },
  {
    code: "W_KURTI_NECKLINE_SLEEVES",
    name: "Kurti Neckline & Sleeves",
    rule: "Covers neckline depth and sleeve length together. Name the sleeve style explicitly whenever it is visible. Short sleeves, half sleeves, cap sleeves and sleeveless are all a FAIL — the standard requires full or three-quarter length. Never pass over a short sleeve in silence.",
  },
  {
    code: "W_KURTI_MATERIAL",
    name: "Kurti Material / Fabric",
    rule: "The fabric must be opaque and professional. FAIL a thin, sheer, see-through or translucent material through which the skin or an underlayer is visible. The kurti should also be a solid plain colour: FAIL a loud or noticeable print or pattern.",
  },
  {
    code: "W_DUPATTA",
    name: "Dupatta",
    rule: "A dupatta is required and must be properly worn — draped and settled deliberately, secured or pinned where the style calls for it. Do not PASS merely because some dupatta fabric is visible. FAIL a dupatta slung loosely over one shoulder, trailing, bunched or clearly not worn as intended, and FAIL when none is present.",
  },
  { code: "W_KURTI_CONDITION", name: "Kurti Condition", rule: "Covers cleanliness, stains, tears, pilling, fading and heavy creasing together." },
  {
    code: "W_BOTTOM_WEAR",
    name: "Bottom Wear",
    rule: "Palazzo, churidar or straight formal trousers in a matching or neutral tone. The fabric must be opaque: FAIL anything visibly thin, sheer or transparent. FAIL jeans, denim, casual cropped trousers and leggings worn as outerwear.",
  },
];

export const WOMEN_ACCESSORIES_CHECKS = [
  {
    code: "W_EARRINGS",
    name: "Earrings",
    rule: "Simple studs or small earrings up to about 2 cm in visible size. FAIL anything clearly larger than 2 cm or visibly oversized. Also FAIL multi-coloured, multi-gem or strongly decorative earrings even when they are within the size limit, whenever that is clearly identifiable.",
  },
  { code: "W_BANGLES", name: "Bangles", rule: "Judge the number and prominence of visible bangles against a modest limit. Bangles are cultural wear and are never a violation merely by existing; FAIL only a clearly excessive or distracting quantity." },
  { code: "W_BINDI", name: "Bindi", rule: "A small, plain bindi passes. Wearing none is not a violation." },
  { code: "W_DISTRACTING_ACCESSORIES", name: "Distracting Accessories", rule: "Other clearly distracting statement pieces." },
  { code: "W_EYEWEAR", name: "Eyewear", rule: "Simple and professional eyewear is permitted. Wearing no eyewear is also PASS. FAIL if the instructor is wearing sunglasses, tinted glasses indoors, or overly fancy/distracting frames." },
  {
    code: "W_WATCH",
    name: "Watch",
    informational: true,
    rule: "Record whether a watch is visible, and nothing more. A watch is optional, so this never affects compliance. Use PASS with an observation stating what is visible, or N/A when the wrists are not visible. Never FAIL.",
  },
];

export const WOMEN_FOOTWEAR_CHECKS = [
  { code: "W_FOOTWEAR_TYPE", name: "Footwear Type", rule: "Closed-toe pumps, kitten heels, ballet flats, loafers and formal open-toe sandals with a back or ankle strap all pass. FAIL flip-flops, slippers, sneakers, sports shoes, wedges, platforms and strappy casual styles. Do not estimate heel height." },
  { code: "W_FOOTWEAR_CONDITION", name: "Footwear Condition", rule: "Covers cleanliness, upkeep and visible damage together." },
];

/** The order the report renders sections in, for every variant. */
export const SECTION_KEYS = [
  "general_idcard_check",
  "grooming_check",
  "attire_check",
  "accessories_check",
  "footwear_check",
];

/**
 * The complete checkpoint set for one instructor.
 *
 * The attire rows are chosen from what the photograph shows, never from
 * gender: a woman in formal trousers is a real case the weekly rotation needs
 * to see, and inferring the garment from the person would hide it.
 *
 * Returns null when gender is unknown. There is deliberately no combined set —
 * sending both dress codes is what produced reports judging a man against
 * saree standards.
 */
export function checkpointSet(gender, attireType) {
  if (gender === "MALE") {
    return {
      general_idcard_check: ID_CARD_CHECKS,
      grooming_check: MEN_GROOMING_CHECKS,
      attire_check: MEN_ATTIRE_CHECKS,
      accessories_check: MEN_ACCESSORIES_CHECKS,
      footwear_check: MEN_FOOTWEAR_CHECKS,
    };
  }
  if (gender === "FEMALE") {
    return {
      general_idcard_check: ID_CARD_CHECKS,
      grooming_check: WOMEN_GROOMING_CHECKS,
      attire_check: attireType === "SAREE" ? SAREE_ATTIRE_CHECKS : KURTI_ATTIRE_CHECKS,
      accessories_check: WOMEN_ACCESSORIES_CHECKS,
      footwear_check: WOMEN_FOOTWEAR_CHECKS,
    };
  }
  return null;
}

/** Codes that are recorded but never scored. */
export const INFORMATIONAL_CODES = new Set(
  [...MEN_ACCESSORIES_CHECKS, ...WOMEN_ACCESSORIES_CHECKS]
    .filter((item) => item.informational)
    .map((item) => item.code)
);

/**
 * Fix suggestions, keyed by checkpoint.
 *
 * Derived from the failing rows rather than asked of the model, so the advice
 * cannot drift between reports or contradict the checkpoint it belongs to.
 * Only FAIL produces a tip: a passing or unassessable checkpoint has nothing
 * to correct, and an informational one has no rule to have broken.
 */
export const IMPROVEMENT_TIPS = {
  ID_PRESENT: "Wear your instructor ID card around your neck at chest level using the official lanyard.",
  M_HAIR_NEATNESS: "Comb your hair neatly before the session.",
  M_HAIR_POSITION: "Keep your hair back and away from your face.",
  M_HAIR_LENGTH: "Trim your hair so it does not fall past the collar.",
  M_FACIAL_HAIR: "Trim and shape your beard, or shave clean.",
  M_MOUSTACHE: "Trim your moustache neatly above the lip line.",
  M_ATTIRE_TYPE: "Wear a formal full-sleeve shirt with formal trousers.",
  M_SHIRT_TYPE: "Wear a formal full-sleeve collared shirt.",
  M_SHIRT_FIT: "Wear a shirt that fits without pulling or bunching.",
  M_SHIRT_CONDITION: "Wear a clean, pressed shirt.",
  M_SHIRT_COLLAR_TUCK: "Button the collar properly and tuck the shirt in.",
  M_TROUSERS_TYPE: "Replace jeans with formal trousers.",
  M_TROUSERS_FIT_CONDITION: "Wear well-fitted, undamaged, pressed trousers.",
  M_BELT: "Wear a formal belt with your trousers.",
  M_RINGS: "Wear at most one ring per hand.",
  M_CHAIN: "Keep chains below the collar line.",
  M_DISTRACTING_ACCESSORIES: "Remove bracelets and statement accessories.",
  M_EYEWEAR: "Wear simple, professional eyewear. Sunglasses and tinted glasses are not permitted indoors.",
  M_FOOTWEAR_TYPE: "Wear clean formal shoes instead of casual footwear.",
  M_FOOTWEAR_CONDITION: "Wear clean, polished shoes.",
  W_HAIR_NEATNESS: "Tie or pin your hair neatly.",
  W_HAIR_POSITION: "Keep your hair back and away from your face.",
  W_HAIR_ACCESSORIES: "Use plain, simple hair accessories.",
  W_MAKEUP: "Keep makeup natural and understated.",
  W_NAILS: "Keep nails trimmed and clean.",
  W_SAREE_ATTIRE_TYPE: "Wear a saree or a kurti with dupatta.",
  W_SAREE_WEARING: "Drape the saree neatly and secure it properly.",
  W_SAREE_PLEATS_PALLU: "Set the pleats evenly and pin the pallu at the shoulder.",
  W_SAREE_BLOUSE: "Wear a blouse with proper sleeves and coverage. Sleeveless blouses are not permitted.",
  W_SAREE_FABRIC: "Wear a clean, pressed, opaque saree.",
  W_SAREE_PRESENTATION: "Check the overall drape and presentation before the session.",
  W_KURTI_ATTIRE_TYPE: "Wear a saree or a kurti with dupatta.",
  W_KURTI_FIT_LENGTH: "Wear a kurti of appropriate length and fit.",
  W_KURTI_NECKLINE_SLEEVES: "Wear a kurti with full or three-quarter sleeves and an appropriate neckline.",
  W_KURTI_MATERIAL: "Wear a plain kurti in an opaque, non-transparent fabric.",
  W_DUPATTA: "Wear the dupatta properly draped and secured, not loosely placed.",
  W_KURTI_CONDITION: "Wear a clean, pressed, undamaged kurti.",
  W_BOTTOM_WEAR: "Wear palazzos, churidar or formal trousers in an opaque fabric.",
  W_EARRINGS: "Wear simple studs or small earrings, no larger than 2 cm.",
  W_BANGLES: "Reduce the number of bangles worn.",
  W_BINDI: "Wear a small, plain bindi.",
  W_DISTRACTING_ACCESSORIES: "Remove statement accessories.",
  W_EYEWEAR: "Wear simple, professional eyewear. Sunglasses and tinted glasses are not permitted indoors.",
  W_FOOTWEAR_TYPE: "Wear formal footwear instead of casual or sports shoes.",
  W_FOOTWEAR_CONDITION: "Wear clean, well-maintained footwear.",
};

/**
 * The tips for one evaluation, in report order.
 *
 * Reads the failing checkpoints rather than the section they sit in, so a tip
 * can never appear for a PASS, an N/A, or a checkpoint that carries no rule.
 */
export function improvementTips(sections) {
  const tips = [];
  for (const key of SECTION_KEYS) {
    for (const item of sections?.[key] || []) {
      if (item.status !== "FAIL" || INFORMATIONAL_CODES.has(item.code)) continue;
      const tip = IMPROVEMENT_TIPS[item.code];
      if (tip && !tips.includes(tip)) tips.push(tip);
    }
  }
  return tips;
}
