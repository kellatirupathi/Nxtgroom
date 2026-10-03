import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveIdCardAbstention } from "../src/services/visionEngine.js";
import { ID_CARD_CHECKS } from "../src/checkpoints.js";
import { buildSystemPrompt } from "../src/prompts.js";

const rowsWith = (status) => ({
  general_idcard_check: [{ code: "ID_PRESENT", status, observation: "o", reason: "r" }],
});
const idStatus = (rows) => rows.general_idcard_check[0].status;

test("the standard forbids judging anything but presence", () => {
  const rule = ID_CARD_CHECKS[0].rule;
  for (const word of ["orientation", "readability", "condition", "lanyard", "position"]) {
    assert.match(rule, new RegExp(word), `the rule must rule out judging ${word}`);
  }
  assert.match(rule, /Never read, quote or judge what is printed on the card/);
});

test("the prompt says a partly shown card is still a card", () => {
  const prompt = buildSystemPrompt("MALE", "FORMAL");
  assert.match(prompt, /"partially visible", "not clearly displayed" or "not fully visible" is not a\nviolation/);
  assert.match(prompt, /An instructor wearing their ID card must never be told to wear one\./);
});

test("an abstention over a visible chest with no card becomes a failure", () => {
  const rows = resolveIdCardAbstention(rowsWith("N/A"), {
    upper_body: "VISIBLE",
    id_card: "NOT_VISIBLE",
  });
  assert.equal(idStatus(rows), "FAIL");
  assert.equal(rows.general_idcard_check[0].reason, "The upper body is visible and no ID card is being worn.");
});

test("an abstention stands when the photograph cannot answer the question", () => {
  for (const upperBody of ["PARTIAL", "NOT_VISIBLE"]) {
    const rows = resolveIdCardAbstention(rowsWith("N/A"), { upper_body: upperBody, id_card: "NOT_VISIBLE" });
    assert.equal(idStatus(rows), "N/A", `upper body ${upperBody} must stay N/A`);
  }
  assert.equal(idStatus(resolveIdCardAbstention(rowsWith("N/A"), undefined)), "N/A");
  assert.equal(idStatus(resolveIdCardAbstention(rowsWith("N/A"), {})), "N/A");
});

test("a card the model can see is never overturned", () => {
  for (const region of ["VISIBLE", "PARTIAL", "NOT_VISIBLE"]) {
    const rows = resolveIdCardAbstention(rowsWith("PASS"), { upper_body: "VISIBLE", id_card: region });
    assert.equal(idStatus(rows), "PASS", `a PASS must survive id_card ${region}`);
  }
  assert.equal(
    idStatus(resolveIdCardAbstention(rowsWith("FAIL"), { upper_body: "VISIBLE", id_card: "NOT_VISIBLE" })),
    "FAIL"
  );
});

test("a report without the ID section is left alone", () => {
  assert.doesNotThrow(() => resolveIdCardAbstention({}, { upper_body: "VISIBLE", id_card: "NOT_VISIBLE" }));
  assert.doesNotThrow(() => resolveIdCardAbstention({ general_idcard_check: [] }, {}));
});
