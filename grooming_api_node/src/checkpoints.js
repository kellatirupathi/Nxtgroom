/**
 * The fixed checkpoint sets every evaluation must return.
 *
 * The model used to invent both the names and the count — the schema accepted
 * any string and any length from 1 to 20 — so two photos of the same person
 * produced different reports and nothing was comparable across people or over
 * time. These tables are now the contract: the prompt is generated from them
 * and the response is validated against them, so a missing row is a rejected
 * response rather than a judgement the model was allowed to make.
 *
 * Codes are stable and internal. Only the name reaches the report.
 */

/** Worn by everyone, so these rows are identical in all three variants. */
export const ID_CARD_CHECKS = [
  { code: "ID_PRESENT", name: "ID Card Present", rule: "The card is being worn." },
  { code: "ID_VISIBILITY", name: "ID Card Visibility", rule: "The card is exposed rather than hidden behind clothing or turned over." },
  { code: "ID_CHEST_POSITION", name: "Chest Level Position", rule: "The card sits roughly at chest level. Minor rotation is acceptable." },
  { code: "ID_OFFICIAL_LANYARD", name: "Official Lanyard", rule: "The official blue instructor lanyard is used." },
  { code: "ID_READABILITY", name: "ID Card Readability", rule: "The photo and text area are legible enough to read. This is not identity verification. If the resolution is too low, answer N/A." },
  { code: "ID_CONDITION", name: "ID Card Condition", rule: "The card is not clearly damaged, broken or badly faded. Minor wear is acceptable." },
];

export const MEN_GROOMING_CHECKS = [
  { code: "M_HAIR_NEATNESS", name: "Hair Neatness", rule: "Hair is combed and looks maintained." },
  { code: "M_HAIR_COLOR", name: "Hair Natural Colour", rule: "No clearly unnatural colouring such as blue, red or green." },
  { code: "M_HAIR_LENGTH", name: "Hair Length", rule: "Hair does not extend past the collar." },
  { code: "M_HAIR_FACE", name: "Hair Away From Face", rule: "Hair does not significantly cover the face." },
  { code: "M_HAIR_PRODUCT", name: "Hair Product / Greasy Appearance", rule: "Fail only clearly excessive product, or a greasy or wet look." },
  { code: "M_FACIAL_HAIR", name: "Facial Hair", rule: "Covers trimming, overgrowth, edge definition and overall beard presentation together. Clean-shaven also passes. Do not split this into separate rows." },
  { code: "M_MOUSTACHE", name: "Moustache", rule: "Does not extend past the lip line." },
  { code: "M_EYEWEAR", name: "Eyewear", rule: "If spectacles are worn, judge professional appearance, fit, obvious dirt and obvious damage together. If none are worn, answer N/A." },
];

export const MEN_ATTIRE_CHECKS = [
  { code: "M_ATTIRE_TYPE", name: "Attire Type", rule: "Classifies the overall visible combination. A formal shirt with formal trousers is expected." },
  { code: "M_SHIRT_STYLE", name: "Shirt Style", rule: "A formal collared shirt. Fail a t-shirt, casual polo or obviously casual shirt. Solid colours and subtle patterns both pass." },
  { code: "M_SHIRT_FIT", name: "Shirt Fit", rule: "Fail major pulling at the buttons, severe tightness or heavy bunching. Ordinary folds are fine." },
  { code: "M_SHIRT_CONDITION", name: "Shirt Condition", rule: "Covers cleanliness, stains, tears, obvious fading or pilling, and heavy creasing together." },
  { code: "M_SHIRT_COLLAR_TUCK", name: "Shirt Collar / Tuck", rule: "Covers collar presentation, no more than one button open, and tucking. If the waist is not visible, say so rather than guessing." },
  { code: "M_TROUSERS_TYPE", name: "Trousers Type", rule: "Formal trousers. Fail jeans, denim, joggers or obviously casual trousers." },
  { code: "M_TROUSERS_FIT_CONDITION", name: "Trousers Fit & Condition", rule: "Covers fit, visible condition, tears or fraying, heavy creasing and hem length together." },
  { code: "M_BELT", name: "Belt", rule: "Presence and formality, judged only when the waist is clearly visible. Otherwise N/A." },
];

export const MEN_ACCESSORIES_CHECKS = [
  { code: "M_WATCH", name: "Watch", rule: "A simple professional watch. Fail clearly oversized or sports-style pieces." },
  { code: "M_RINGS", name: "Rings", rule: "At most one visible ring per hand." },
  { code: "M_CHAIN", name: "Chain / Necklace", rule: "No distracting chain visible above the collar." },
  { code: "M_DISTRACTING_ACCESSORIES", name: "Bracelets / Distracting Accessories", rule: "Bracelets and other clearly distracting statement pieces, judged together." },
];

export const MEN_FOOTWEAR_CHECKS = [
  { code: "M_FOOTWEAR_TYPE", name: "Footwear Type", rule: "Formal leather or formal synthetic shoes pass. Sneakers, sports shoes, sandals and chappals fail." },
  { code: "M_FOOTWEAR_CONDITION", name: "Footwear Condition", rule: "Covers cleanliness, polish, visible damage and worn-out state together." },
];

export const WOMEN_GROOMING_CHECKS = [
  { code: "W_HAIR_NEATNESS", name: "Hair Neatness", rule: "Tied, braided or pinned all pass. Loose hair also passes when it stays neat." },
  { code: "W_HAIR_COLOR", name: "Hair Natural Colour", rule: "No clearly unnatural colouring." },
  { code: "W_HAIR_FACE", name: "Hair Away From Face", rule: "Hair does not significantly obstruct the face." },
  { code: "W_HAIR_ACCESSORIES", name: "Hair Accessories", rule: "Plain, simple accessories. Fail only clearly oversized or decorative ones." },
  { code: "W_MAKEUP", name: "Makeup", rule: "Natural professional appearance judged as one thing, with no separate foundation, lip and eye rows. If lighting or colour rendering is unreliable, answer N/A rather than guessing." },
  { code: "W_EYEWEAR", name: "Eyewear", rule: "As for men: appearance, fit, dirt and damage together, or N/A when none are worn." },
];

export const SAREE_ATTIRE_CHECKS = [
  { code: "W_SAREE_ATTIRE_TYPE", name: "Attire Type", rule: "Confirms a saree is the visible garment." },
  { code: "W_SAREE_DRAPE_PLEATS", name: "Saree Drape & Pleats", rule: "Covers neat draping, organised pleats and absence of severe bunching or sagging." },
  { code: "W_SAREE_PALLU", name: "Pallu", rule: "Covers placement, visible length and pinned or managed appearance." },
  { code: "W_SAREE_BLOUSE", name: "Blouse Fit & Coverage", rule: "Covers fit, neckline, sleeve coverage and exposed straps or pins together." },
  { code: "W_SAREE_FABRIC", name: "Saree Fabric / Pattern", rule: "Solid or subtle patterns pass. Fail clearly loud or casual fabric." },
  { code: "W_SAREE_CONDITION", name: "Saree Condition", rule: "Covers stains, fading, fraying, snags, tears and heavy creasing together." },
  { code: "W_SAREE_WAIST_PETTICOAT", name: "Saree Waist / Petticoat", rule: "Waist presentation, and petticoat not showing below the saree. N/A when not visible." },
];

export const KURTI_ATTIRE_CHECKS = [
  { code: "W_KURTI_ATTIRE_TYPE", name: "Attire Type", rule: "Confirms a kurti is the visible garment." },
  { code: "W_KURTI_FIT_LENGTH", name: "Kurti Fit & Length", rule: "Covers fit, length and side slit height together." },
  { code: "W_KURTI_NECKLINE_SLEEVES", name: "Kurti Neckline & Sleeves", rule: "Covers neckline depth and sleeve coverage together." },
  { code: "W_DUPATTA", name: "Dupatta", rule: "A dupatta is required with a kurti and must be worn neatly. Missing is a FAIL." },
  { code: "W_KURTI_FABRIC", name: "Kurti Fabric / Pattern", rule: "Solid or subtle prints pass. Fail clearly loud or casual patterns." },
  { code: "W_KURTI_CONDITION", name: "Kurti Condition", rule: "Covers cleanliness, stains, tears, pilling, fading and heavy creasing together." },
  { code: "W_BOTTOM_WEAR", name: "Bottom Wear", rule: "Palazzo, churidar or straight formal trousers pass. Fail jeans, casual cropped trousers and leggings worn as outerwear." },
];

export const WOMEN_ACCESSORIES_CHECKS = [
  { code: "W_WATCH", name: "Watch", rule: "A simple professional watch." },
  { code: "W_EARRINGS", name: "Earrings", rule: "Studs or small earrings. Fail only clearly large or dangling pieces." },
  { code: "W_BANGLES", name: "Bangles", rule: "Judge visible quantity and style. Bangles are cultural wear and never a violation merely by existing." },
  { code: "W_BINDI", name: "Bindi", rule: "A small plain bindi passes. Wearing none is not a violation." },
  { code: "W_CHAIN", name: "Chain / Mangalsutra", rule: "A mangalsutra is culturally acceptable and never a violation merely by existing. N/A when none is visible." },
  { code: "W_NOSE_PIN", name: "Nose Pin", rule: "A small stud passes. N/A when none is worn." },
  { code: "W_DISTRACTING_ACCESSORIES", name: "Distracting Accessories", rule: "Other clearly distracting statement pieces." },
];

export const WOMEN_FOOTWEAR_CHECKS = [
  { code: "W_FOOTWEAR_TYPE", name: "Footwear Type", rule: "Closed-toe pumps, kitten heels, ballet flats, loafers and formal open-toe sandals with a back or ankle strap all pass. Fail flip-flops, sneakers, sports shoes, wedges, platforms and strappy casual styles." },
  { code: "W_FOOTWEAR_CONDITION", name: "Footwear Condition", rule: "Covers cleanliness, upkeep and visible damage together." },
  { code: "W_HEEL_HEIGHT", name: "Heel Height", rule: "Up to three inches. Judge only when the heel is clearly visible, otherwise N/A." },
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

/**
 * Fix suggestions, keyed by checkpoint.
 *
 * Derived from the failing rows rather than asked of the model, so the advice
 * cannot drift between reports or contradict the checkpoint it belongs to.
 * Only FAIL produces a tip: a passing or unassessable checkpoint has nothing
 * to correct.
 */
export const IMPROVEMENT_TIPS = {
  ID_PRESENT: "Wear your instructor ID card.",
  ID_VISIBILITY: "Keep the ID card in front of your clothing, facing outward.",
  ID_CHEST_POSITION: "Wear the ID card at chest level.",
  ID_OFFICIAL_LANYARD: "Use the official blue instructor lanyard.",
  ID_READABILITY: "Make sure the ID card is clean and facing forward.",
  ID_CONDITION: "Replace the damaged ID card.",
  M_HAIR_NEATNESS: "Comb your hair neatly before the session.",
  M_HAIR_COLOR: "Return to a natural hair colour.",
  M_HAIR_LENGTH: "Trim your hair so it does not fall past the collar.",
  M_HAIR_FACE: "Style your hair away from your face.",
  M_HAIR_PRODUCT: "Use less hair product.",
  M_FACIAL_HAIR: "Trim and shape your beard, or shave clean.",
  M_MOUSTACHE: "Trim your moustache above the lip line.",
  M_EYEWEAR: "Wear clean, undamaged spectacles with a professional frame.",
  M_ATTIRE_TYPE: "Wear a formal shirt with formal trousers.",
  M_SHIRT_STYLE: "Wear a formal collared shirt.",
  M_SHIRT_FIT: "Wear a shirt that fits without pulling or bunching.",
  M_SHIRT_CONDITION: "Wear a clean, pressed shirt.",
  M_SHIRT_COLLAR_TUCK: "Button the collar properly and tuck the shirt in.",
  M_TROUSERS_TYPE: "Replace jeans with formal trousers.",
  M_TROUSERS_FIT_CONDITION: "Wear well-fitted, undamaged, pressed trousers.",
  M_BELT: "Wear a formal belt with your trousers.",
  M_WATCH: "Wear a simple watch with a plain dial.",
  M_RINGS: "Wear at most one ring per hand.",
  M_CHAIN: "Keep chains below the collar line.",
  M_DISTRACTING_ACCESSORIES: "Remove bracelets and statement accessories.",
  M_FOOTWEAR_TYPE: "Wear clean formal shoes instead of sneakers.",
  M_FOOTWEAR_CONDITION: "Wear clean, polished shoes.",
  W_HAIR_NEATNESS: "Tie or pin your hair neatly.",
  W_HAIR_COLOR: "Return to a natural hair colour.",
  W_HAIR_FACE: "Keep your hair away from your face.",
  W_HAIR_ACCESSORIES: "Use plain, simple hair accessories.",
  W_MAKEUP: "Keep makeup natural and understated.",
  W_EYEWEAR: "Wear clean, undamaged spectacles with a professional frame.",
  W_SAREE_ATTIRE_TYPE: "Wear a saree or a kurti with dupatta.",
  W_SAREE_DRAPE_PLEATS: "Drape the saree neatly with even pleats.",
  W_SAREE_PALLU: "Pin the pallu neatly at the shoulder.",
  W_SAREE_BLOUSE: "Wear a well-fitted blouse with appropriate coverage.",
  W_SAREE_FABRIC: "Choose a solid or subtly patterned saree.",
  W_SAREE_CONDITION: "Wear a clean, pressed, undamaged saree.",
  W_SAREE_WAIST_PETTICOAT: "Adjust the saree so the petticoat does not show.",
  W_KURTI_ATTIRE_TYPE: "Wear a saree or a kurti with dupatta.",
  W_KURTI_FIT_LENGTH: "Wear a kurti of appropriate length and fit.",
  W_KURTI_NECKLINE_SLEEVES: "Choose a kurti with appropriate neckline and sleeves.",
  W_DUPATTA: "Wear a dupatta with the kurti.",
  W_KURTI_FABRIC: "Choose a solid or subtly patterned kurti.",
  W_KURTI_CONDITION: "Wear a clean, pressed, undamaged kurti.",
  W_BOTTOM_WEAR: "Wear palazzos, churidar or formal trousers.",
  W_WATCH: "Wear a simple watch with a plain dial.",
  W_EARRINGS: "Wear studs or small earrings.",
  W_BANGLES: "Reduce the number of bangles worn.",
  W_BINDI: "Wear a small, plain bindi.",
  W_CHAIN: "Keep neck chains simple and understated.",
  W_NOSE_PIN: "Wear a small stud rather than a larger nose ring.",
  W_DISTRACTING_ACCESSORIES: "Remove statement accessories.",
  W_FOOTWEAR_TYPE: "Wear formal footwear instead of casual or sports shoes.",
  W_FOOTWEAR_CONDITION: "Wear clean, well-maintained footwear.",
  W_HEEL_HEIGHT: "Wear heels no higher than three inches.",
};

/**
 * The tips for one evaluation, in report order.
 *
 * Reads the failing checkpoints rather than the section they sit in, so a tip
 * can never appear for a PASS or an N/A.
 */
export function improvementTips(sections) {
  const tips = [];
  for (const key of SECTION_KEYS) {
    for (const item of sections?.[key] || []) {
      if (item.status !== "FAIL") continue;
      const tip = IMPROVEMENT_TIPS[item.code];
      if (tip && !tips.includes(tip)) tips.push(tip);
    }
  }
  return tips;
}
