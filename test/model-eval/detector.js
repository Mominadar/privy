/*
 * Runs a downloaded model through the extension's scan pipeline in Node.
 *
 * The extension uses ONNX Runtime WASM; Node uses ONNX Runtime native. Both
 * load the same quantized weights, so scores can differ only by rounding.
 */
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APPROVED_MODELS, DEFAULT_MODEL } from "../../model-policy.js";
import "../../model-prompts.js";
import { chunkText } from "../../entity-normalization.js";
import { findingsFromModelOutputs } from "../../scan-pipeline.js";

export const MODELS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../models");
export const EVAL_MODEL = process.env.PRIVY_EVAL_MODEL || DEFAULT_MODEL;

export async function isDownloaded(modelId) {
  const files = Object.keys(APPROVED_MODELS[modelId]?.files || { "onnx/model_quantized.onnx": null, "config.json": null });
  try {
    await Promise.all(files.map((file) => access(join(MODELS_DIR, modelId, file))));
    return true;
  } catch {
    return false;
  }
}

export async function loadScanner(modelId) {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.localModelPath = `${MODELS_DIR}/`;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  const detector = await pipeline("token-classification", modelId, { dtype: "q8" });
  const policy = globalThis.PrivyModelPrompts;

  return async function scan(text) {
    const chunks = chunkText(text);
    const outputs = await detector(chunks.map((chunk) => chunk.text), { aggregation_strategy: "simple" });
    return findingsFromModelOutputs({
      text,
      chunks,
      // A single input returns a flat array rather than one array per input.
      outputs,
      modelId,
      policy,
      isSingleToken: (word) => detector.tokenizer.tokenize(word).length === 1,
    });
  };
}

const TYPE_GROUPS = { PER: "PERSON", LOC: "LOCATION", ORG: "ORGANIZATION" };
export const typeGroup = (type) => TYPE_GROUPS[type] || type;

function occurrences(text, value) {
  const spans = [];
  for (let index = text.indexOf(value); index !== -1; index = text.indexOf(value, index + 1)) {
    spans.push([index, index + value.length]);
  }
  return spans;
}

/** Grades one case: which expected values leaked, and which look-alikes were redacted. */
export function grade(testCase, findings) {
  const redacted = findings.filter((item) => !item.weak && Number.isInteger(item.start));
  const covering = (start, end) => redacted.filter((item) => item.start < end && item.end > start);
  const isCovered = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (/\s/.test(testCase.text[index])) continue;
      if (!redacted.some((item) => item.start <= index && item.end > index)) return false;
    }
    return true;
  };

  const missed = [];
  const typeMismatches = [];
  const seen = new Map();
  for (const [type, value] of testCase.pii || []) {
    const nth = seen.get(value) || 0;
    seen.set(value, nth + 1);
    const span = occurrences(testCase.text, value)[nth];
    if (!span) throw new Error(`Case "${testCase.name}" does not contain "${value}"`);
    if (!isCovered(...span)) {
      missed.push(value);
      continue;
    }
    const types = covering(...span).map((item) => typeGroup(item.type));
    if (!types.includes(type)) typeMismatches.push(`${value}: expected ${type}, got ${types.join("/")}`);
  }

  const falsePositives = (testCase.notPii || []).filter((value) =>
    occurrences(testCase.text, value).some((span) => covering(...span).length > 0)
  );

  return { missed, falsePositives, typeMismatches, passed: !missed.length && !falsePositives.length };
}
