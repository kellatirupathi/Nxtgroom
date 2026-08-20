import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveIdCardAbstention } from "../src/services/visionEngine.js";
import { ID_CARD_CHECKS } from "../src/checkpoints.js";
import { buildSystemPrompt } from "../src/prompts.js";

/**
 * The ID card checkpoint asks whether a card is being worn, and nothing else.
 *
 * It was failing instructors who were plainly wearing one, for "not clearly
 * displayed" — judging how well the photograph showed the card rather than
 * whether the person had it on, and then advising them to wear the card they
 * were already wearing.
 */

const rowsWith = (status) => ({
  general_idcard_check: [{ code: "ID_PRESENT", status, observation: "o", reason: "r" }],
});
const idStatus = (rows) => rows.general_idcard_check[0].status;

test("the standard forbids judging anything but presence", () => {
  const rule = ID_CARD_CHECKS[0].rule;
  // The specific words the model used to fail people on.
  for (const word of ["orientation", "readability", "condition", "lanyard", "position"]) {
    assert.match(rule, new RegExp(word), `the rule must rule out judging ${word}`);
  }
  assert.match(rule, /Never read, quote or judge what is printed on the card/);
});

test("the prompt says a partly shown card is still a card", () => {
  const prompt = buildSystemPrompt("MALE", "FORMAL");
  // Verbatim phrases from the report that failed a compliant instructor.
  assert.match(prompt, /"partially visible", "not clearly displayed" or "not fully visible" is not a\nviolation/);
  assert.match(prompt, /An instructor wearing their ID card must never be told to wear one\./);
});

test("an abstention over a visible chest with no card becomes a failure", () => {
  // The model returned N/A while giving the FAIL condition as its reason, so
  // the regions settle it rather than the wording.
  const rows = resolveIdCardAbstention(rowsWith("N/A"), {
    upper_body: "VISIBLE",
    id_card: "NOT_VISIBLE",
  });
  assert.equal(idStatus(rows), "FAIL");
  assert.equal(rows.general_idcard_check[0].reason, "The upper body is visible and no ID card is being worn.");
});

test("an abstention stands when the photograph cannot answer the question", () => {
  // A chest that is cut off or obscured genuinely cannot be judged, and
  // guessing FAIL there accuses somebody on the strength of the framing.
  for (const upperBody of ["PARTIAL", "NOT_VISIBLE"]) {
    const rows = resolveIdCardAbstention(rowsWith("N/A"), { upper_body: upperBody, id_card: "NOT_VISIBLE" });
    assert.equal(idStatus(rows), "N/A", `upper body ${upperBody} must stay N/A`);
  }
  assert.equal(idStatus(resolveIdCardAbstention(rowsWith("N/A"), undefined)), "N/A");
  assert.equal(idStatus(resolveIdCardAbstention(rowsWith("N/A"), {})), "N/A");
});

test("a card the model can see is never overturned", () => {
  // Only the abstention is corrected. A PASS is a sighting, and no region flag
  // may turn it into an accusation.
  for (const region of ["VISIBLE", "PARTIAL", "NOT_VISIBLE"]) {
    const rows = resolveIdCardAbstention(rowsWith("PASS"), { upper_body: "VISIBLE", id_card: region });
    assert.equal(idStatus(rows), "PASS", `a PASS must survive id_card ${region}`);
  }
  // A FAIL the model reached on its own is left exactly as it is.
  assert.equal(
    idStatus(resolveIdCardAbstention(rowsWith("FAIL"), { upper_body: "VISIBLE", id_card: "NOT_VISIBLE" })),
    "FAIL"
  );
});

test("a report without the ID section is left alone", () => {
  assert.doesNotThrow(() => resolveIdCardAbstention({}, { upper_body: "VISIBLE", id_card: "NOT_VISIBLE" }));
  assert.doesNotThrow(() => resolveIdCardAbstention({ general_idcard_check: [] }, {}));
});
