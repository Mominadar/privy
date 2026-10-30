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

test("model words without offsets are aligned to whole words in reading order", async () => {
  const { alignEntities } = await import("../entity-normalization.js");
  const text = "annual report by Ann, then Ann again";
  const aligned = alignEntities([
    { type: "PER", value: "Ann", start: null, end: null },
    { type: "PER", value: "Ann", start: null, end: null },
  ], text);
  assert.deepEqual(aligned.map(({ start }) => start), [17, 27]);
});

test("entities missing trailing or middle subwords widen to whole words", async () => {
  const { alignEntities, widenToWords } = await import("../entity-normalization.js");
  const text = "Grace Mwangi called. Mi hermana Lucía Fernández llamó.";
  const aligned = widenToWords(alignEntities([
    { type: "PER", value: "Grace Mwang", start: null, end: null },
    { type: "PER", value: "Luc Fernández", start: null, end: null },
  ], text), text);
  assert.deepEqual(aligned.map(({ value }) => value), ["Grace Mwangi", "Lucía Fernández"]);
});

test("pieces split mid-word merge before widening", async () => {
  const { alignEntities, mergeAdjacentEntities, widenToWords } = await import("../entity-normalization.js");
  const text = "Ayesha Khan and Priya Raghunathan";
  const pieces = alignEntities([
    { type: "PER", value: "Aye", source: "m", score: 1, start: null, end: null },
    { type: "PER", value: "sha Khan", source: "m", score: 1, start: null, end: null },
    { type: "PER", value: "P", source: "m", score: 1, start: null, end: null },
    { type: "PER", value: "riya Raghunathan", source: "m", score: 1, start: null, end: null },
  ], text);
  const merged = widenToWords(mergeAdjacentEntities(pieces, text), text);
  assert.deepEqual(merged.map(({ value }) => value), ["Ayesha Khan", "Priya Raghunathan"]);
});

test("fragments that start inside a word are not widened", async () => {
  const { widenToWords } = await import("../entity-normalization.js");
  const [widened] = widenToWords([{ type: "ORG", value: "gree", start: 4, end: 8 }], "evergreen");
  assert.equal(widened.value, "gree");
});

test("long messages are chunked so later text is still scanned", async () => {
  const { chunkText } = await import("../entity-normalization.js");
  const text = "Sentence one is here. ".repeat(100) + "Momina";
  const chunks = chunkText(text, 800);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((chunk) => chunk.text).join(""), text);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 800));
});
