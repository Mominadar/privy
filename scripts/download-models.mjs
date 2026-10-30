/*
 * Downloads model files into models/ for the local evaluation suite.
 *
 *   node scripts/download-models.mjs                 # default model
 *   node scripts/download-models.mjs --all           # every approved model
 *   node scripts/download-models.mjs owner/model     # one approved model
 *   node scripts/download-models.mjs owner/model --revision <sha>
 *                                                    # candidate not yet in the allowlist
 *
 * Approved models are verified against the SHA-256 manifest in
 * model-policy.js. Candidate models print their hashes so they can be pinned.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APPROVED_MODELS, DEFAULT_MODEL, isValidHuggingFaceModelId, modelFileUrl } from "../model-policy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MODELS_DIR = join(ROOT, "models");
const CANDIDATE_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function existingHash(path) {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

async function downloadModel(modelId, revisionOverride) {
  const approved = APPROVED_MODELS[modelId];
  if (!approved && !revisionOverride) {
    throw new Error(`${modelId} is not in model-policy.js. Pass --revision <commit> to evaluate it as a candidate.`);
  }
  const revision = revisionOverride || approved.revision;
  const files = approved && !revisionOverride
    ? Object.entries(approved.files)
    : CANDIDATE_FILES.map((filename) => [filename, null]);

  console.log(`${modelId}@${revision.slice(0, 12)}`);
  for (const [filename, expected] of files) {
    const target = join(MODELS_DIR, modelId, filename);
    if (expected && (await existingHash(target)) === expected) {
      console.log(`  ✓ ${filename} (cached)`);
      continue;
    }
    const response = await fetch(modelFileUrl(modelId, revision, filename));
    if (!response.ok) throw new Error(`${filename}: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const actual = sha256(buffer);
    if (expected && actual !== expected) {
      throw new Error(`${filename}: SHA-256 mismatch (expected ${expected}, got ${actual})`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buffer);
    console.log(`  ${expected ? "✓" : "?"} ${filename} ${(buffer.length / 1e6).toFixed(1)} MB${expected ? "" : ` sha256=${actual}`}`);
  }
}

const args = process.argv.slice(2);
const revisionIndex = args.indexOf("--revision");
const revision = revisionIndex === -1 ? null : args[revisionIndex + 1];
const positional = args.filter((arg, index) => !arg.startsWith("--") && index !== revisionIndex + 1);
const modelIds = args.includes("--all")
  ? Object.keys(APPROVED_MODELS)
  : positional.length ? positional : [process.env.PRIVY_EVAL_MODEL || DEFAULT_MODEL];

for (const modelId of modelIds) {
  if (!isValidHuggingFaceModelId(modelId)) throw new Error(`Invalid model ID: ${modelId}`);
  await downloadModel(modelId, revision);
}
