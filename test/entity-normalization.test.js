import assert from "node:assert/strict";
import test from "node:test";

import { mergeAdjacentEntities, normalizeEntity } from "../entity-normalization.js";

test("normalization uses source offsets instead of tokenizer artifacts", () => {
  const text = "Contact Momina today";
  assert.deepEqual(
    normalizeEntity(
      { entity: "B-PER", word: "Mo ##mina", score: 0.99, start: 8, end: 14 },
      "test/model",
      text,
    ),
    {
      type: "PER",
      value: "Momina",
      source: "test/model",
      score: 0.99,
      start: 8,
      end: 14,
    },
  );
});

test("private model labels map to public redaction categories", () => {
  const text = "Momina";
  const entity = normalizeEntity(
    { entity_group: "PRIVATE_PERSON", score: 1, start: 0, end: 6 },
    "test/model",
    text,
  );
  assert.equal(entity.type, "PERSON");
});

test("adjacent same-type tokenizer pieces merge using original text", () => {
  const text = "evergreen";
  const merged = mergeAdjacentEntities([
    { type: "ORG", value: "ever", source: "model", score: 0.9, start: 0, end: 4 },
    { type: "ORG", value: "green", source: "model", score: 0.8, start: 4, end: 9 },
  ], text);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].value, "evergreen");
  assert.equal(merged[0].start, 0);
  assert.equal(merged[0].end, 9);
});

test("different entity types do not merge", () => {
  const merged = mergeAdjacentEntities([
    { type: "PERSON", value: "A", source: "model", score: 1, start: 0, end: 1 },
    { type: "ORG", value: "B", source: "model", score: 1, start: 2, end: 3 },
  ], "A B");
  assert.equal(merged.length, 2);
});

test.todo("BIOES E- and S- prefixes normalize to their base entity types");
test.todo("PRIVATE_DATE remains a generic private date unless DOB context establishes a birth date");
