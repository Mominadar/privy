import assert from "node:assert/strict";
import test from "node:test";

import "../model-prompts.js";
import "../pseudonymization.js";

const pseudo = globalThis.PrivyPseudonymization;
const { placeholders } = globalThis.PrivyModelPrompts;

function rangesFor(message, items) {
  return items.map(([type, value]) => {
    const start = message.indexOf(value);
    return { type, start, end: start + value.length };
  }).sort((a, b) => a.start - b.start);
}

test("each distinct value gets a unique numbered token and repeats reuse it", () => {
  const vault = pseudo.createVault();
  const message = "Momina emailed Ali at momina@unicef.org";
  const redacted = pseudo.pseudonymize(message, rangesFor(message, [
    ["PER", "Momina"], ["PER", "Ali"], ["EMAIL", "momina@unicef.org"],
  ]), vault, placeholders);
  assert.equal(redacted, "[PERSON_1] emailed [PERSON_2] at [EMAIL_1]");

  const followUp = "Tell momina hello";
  assert.equal(
    pseudo.pseudonymize(followUp, rangesFor(followUp, [["PERSON", "momina"]]), vault, placeholders),
    "Tell [PERSON_1] hello",
  );
});

test("responses are restored from the local mapping, with or without brackets", () => {
  const vault = pseudo.createVault({
    PERSON_1: { type: "PER", value: "Momina" },
    PAYMENT_CARD_1: { type: "CREDIT_CARD", value: "4111 1111 1111 1111" },
  });
  const { text, restored } = pseudo.restore("Dear [PERSON_1], card PAYMENT_CARD_1 is ok. [PERSON_9] unknown.", vault);
  assert.equal(text, "Dear Momina, card 4111 1111 1111 1111 is ok. [PERSON_9] unknown.");
  assert.deepEqual(restored.map(({ start, end }) => text.slice(start, end)), ["Momina", "4111 1111 1111 1111"]);
});

test("learned private terms match token boundaries and do not redact substrings such as Ann in annual", () => {
  assert.deepEqual(pseudo.findWholeWord("Ann filed the annual report for ann.", "Ann"), [0, 32]);
  assert.deepEqual(pseudo.findWholeWord("mail @momina now", "@momina"), [5]);
});

test("previously tokenized values are found again in later messages", () => {
  const vault = pseudo.createVault({ PERSON_1: { type: "PER", value: "Momina" } });
  const findings = pseudo.vaultFindings("Ask Momina and momina.", vault);
  assert.deepEqual(findings.map(({ start }) => start), [4, 15]);
});

test("conversation ids come from each site's URL format", () => {
  assert.equal(pseudo.conversationId("chatgpt.com", "/c/abc-123"), "abc-123");
  assert.equal(pseudo.conversationId("chatgpt.com", "/g/g-xyz/c/abc-123"), "abc-123");
  assert.equal(pseudo.conversationId("claude.ai", "/chat/9f1e"), "9f1e");
  assert.equal(pseudo.conversationId("gemini.google.com", "/app/42ab"), "42ab");
  assert.equal(pseudo.conversationId("chatgpt.com", "/"), null);
});
