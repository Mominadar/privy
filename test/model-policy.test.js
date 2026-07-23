import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVED_MODELS,
  isValidHuggingFaceModelId,
  modelFileUrl,
} from "../model-policy.js";

test("approved models use immutable revisions and SHA-256 manifests", () => {
  for (const [modelId, model] of Object.entries(APPROVED_MODELS)) {
    assert.match(modelId, /^[^/]+\/[^/]+$/);
    assert.match(model.revision, /^[a-f0-9]{40}$/);
    assert.ok(model.approximateSize > 0);
    for (const [filename, digest] of Object.entries(model.files)) {
      assert.doesNotMatch(filename, /(?:^|\/)\.\.(?:\/|$)|[?#]/);
      assert.match(digest, /^[a-f0-9]{64}$/);
    }
  }
});

test("custom Hugging Face model IDs reject path and URL injection", () => {
  for (const valid of ["owner/model", "openai/privacy-filter", "a_b/model.v2"]) {
    assert.equal(isValidHuggingFaceModelId(valid), true);
  }
  for (const invalid of [
    "../model",
    "owner/../model",
    "owner/model/extra",
    "owner/model?download=true",
    "https://huggingface.co/owner/model",
    "owner model/repo",
  ]) {
    assert.equal(isValidHuggingFaceModelId(invalid), false);
  }
});

test("model URLs pin the requested immutable revision", () => {
  assert.equal(
    modelFileUrl("owner/model", "a".repeat(40), "onnx/model.onnx"),
    `https://huggingface.co/owner/model/resolve/${"a".repeat(40)}/onnx/model.onnx`,
  );
});

test.todo("modelFileUrl rejects or encodes metadata filenames containing traversal, query, or fragment syntax");
