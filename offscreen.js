import { APPROVED_MODELS, DEFAULT_MODEL, getApprovedModel, modelFileUrl } from "./model-policy.js";
import "./model-prompts.js";
import { chunkText } from "./entity-normalization.js";
import { findingsFromModelOutputs } from "./scan-pipeline.js";

const CACHE_NAME = "verified-huggingface-models-v1";
const MAX_DOWNLOAD_ATTEMPTS = 5;
const HEADER_TIMEOUT_MS = 20_000;
const BODY_STALL_TIMEOUT_MS = 60_000;
const loadedPipelines = new Map();
const activeDownloads = new Map();
const detectionInstructions = globalThis.PrivyModelPrompts;
let runtimePromise;

async function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = import("./vendor/transformers.bundle.js").then((runtime) => {
      const { env } = runtime;
      // Transformers.js 4 resolves repository IDs through its remote URL path.
      // Its fetch implementation is replaced below with a cache-only adapter,
      // so enabling URL resolution does not grant network access.
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.fetch = verifiedModelFetch;
      env.useBrowserCache = false;
      env.useCustomCache = true;
      env.customCache = verifiedCache;
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/");
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      return runtime;
    });
  }
  return runtimePromise;
}

function approvedUrlSet() {
  const urls = new Set();
  for (const [modelId, model] of Object.entries(APPROVED_MODELS)) {
    for (const filename of Object.keys(model.files)) {
      urls.add(modelFileUrl(modelId, model.revision, filename));
    }
  }
  return urls;
}

const approvedUrls = approvedUrlSet();
let customModelPolicy = null;
async function getModelPolicy(modelId) {
  const approved = getApprovedModel(modelId);
  if (approved) return approved;
  return customModelPolicy?.id === modelId ? customModelPolicy : null;
}

function canonicalModelUrl(requestUrl) {
  if (approvedUrls.has(requestUrl)) return requestUrl;
  const policies = [
    ...Object.entries(APPROVED_MODELS).map(([id, policy]) => ({ id, ...policy })),
    ...(customModelPolicy ? [customModelPolicy] : []),
  ];
  for (const model of policies) {
    for (const filename of Object.keys(model.files)) {
      const canonical = modelFileUrl(model.id, model.revision, filename);
      const localPath = `/models/${model.id}/${filename}`;
      if (requestUrl === canonical || requestUrl.endsWith(localPath)) return canonical;
    }
  }
  return null;
}

const verifiedCache = {
  async match(request) {
    const url = typeof request === "string" ? request : request.url;
    const canonical = canonicalModelUrl(url);
    if (!canonical) return undefined;
    return (await caches.open(CACHE_NAME)).match(canonical);
  },
  async put() {
    throw new Error("Transformer runtime cannot add unverified model files");
  },
};

async function verifiedModelFetch(input) {
  const requestUrl = typeof input === "string" ? input : input.url;
  const canonical = canonicalModelUrl(requestUrl);
  if (!canonical) {
    return new Response("Runtime network access is blocked", { status: 404 });
  }
  const cached = await (await caches.open(CACHE_NAME)).match(canonical);
  return cached || new Response("Verified model file is not cached", { status: 404 });
}

function progress(status, value, error = "") {
  return chrome.runtime.sendMessage({
    target: "background",
    type: "model-progress",
    status,
    progress: Math.round(value),
    error,
  }).catch(() => {});
}

function diagnosticLog(level, event, model, detail = "") {
  return chrome.runtime.sendMessage({
    target: "background",
    type: "log-event",
    entry: { level, event, model, detail },
  }).catch(() => {});
}

function runtimeErrorDetail(error) {
  const name = error?.name || "Error";
  const message = error?.message || String(error);
  const stack = typeof error?.stack === "string" ? error.stack : "";
  return `${name}: ${message}${stack ? `\n${stack}` : ""}`;
}

async function ensureModelPipeline(modelId, model) {
  if (!loadedPipelines.has(modelId)) {
    await diagnosticLog("info", "model-pipeline-initializing", modelId, model.custom ? "Custom model compatibility test" : "");
    const { pipeline } = await getRuntime();
    loadedPipelines.set(modelId, pipeline("token-classification", modelId, {
      dtype: model.dtype || "q8",
      device: model.device || "wasm",
      revision: model.revision,
      local_files_only: false,
    }));
  }
  try {
    const detector = await loadedPipelines.get(modelId);
    await diagnosticLog("info", "model-pipeline-ready", modelId);
    return detector;
  } catch (error) {
    loadedPipelines.delete(modelId);
    await diagnosticLog("error", "model-pipeline-incompatible", modelId, runtimeErrorDetail(error));
    throw new Error(`Model is incompatible with the local Transformers.js runtime: ${error.message || String(error)}`);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchWithRetry(url, filename, currentProgress, downloadSignal) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    downloadSignal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
    try {
      progress(
        attempt === 1 ? "downloading" : "retrying",
        currentProgress,
        attempt === 1 ? "" : `Retrying ${filename} (${attempt}/${MAX_DOWNLOAD_ATTEMPTS})`
      );
      const requestUrl = attempt % 2 === 0 ? `${url}?download=true` : url;
      const response = await fetch(requestUrl, {
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        return response;
      }
      if (!isRetryableStatus(response.status)) {
        throw new Error(`Download failed for ${filename}: HTTP ${response.status}`);
      }
      lastError = new Error(`Hugging Face returned HTTP ${response.status} for ${filename}`);
    } catch (error) {
      clearTimeout(timeout);
      downloadSignal.removeEventListener("abort", cancel);
      if (downloadSignal.aborted) throw new DOMException("Download cancelled", "AbortError");
      if (error.message?.startsWith("Download failed")) throw error;
      lastError = error.name === "AbortError"
        ? new Error(`Hugging Face timed out while starting ${filename}`)
        : error;
    }

    if (attempt < MAX_DOWNLOAD_ATTEMPTS) {
      await wait(Math.min(16_000, 1_000 * (2 ** (attempt - 1))) + Math.random() * 500);
      if (downloadSignal.aborted) throw new DOMException("Download cancelled", "AbortError");
    }
  }

  throw new Error(`${lastError?.message || `Download failed for ${filename}`} after ${MAX_DOWNLOAD_ATTEMPTS} attempts`);
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readDownload(response, onProgress) {
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    let stallTimer;
    const stalled = new Promise((_resolve, reject) => {
      stallTimer = setTimeout(() => reject(new Error("Download stalled with no data for 60 seconds")), BODY_STALL_TIMEOUT_MS);
    });
    let chunk;
    try {
      chunk = await Promise.race([reader.read(), stalled]);
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      clearTimeout(stallTimer);
    }
    const { done, value } = chunk;
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received);
  }
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

async function isModelReady(modelId) {
  const model = await getModelPolicy(modelId);
  if (!model) return false;
  const cache = await caches.open(CACHE_NAME);
  const results = await Promise.all(
    Object.keys(model.files).map((filename) =>
      cache.match(modelFileUrl(modelId, model.revision, filename))
    )
  );
  return results.every(Boolean);
}

async function modelDetails(modelId) {
  const model = await getModelPolicy(modelId);
  if (!model) throw new Error("Unknown local model");
  const cache = await caches.open(CACHE_NAME);
  const files = await Promise.all(
    Object.entries(model.files).map(async ([filename, sha256]) => ({
      filename,
      sha256,
      downloaded: Boolean(await cache.match(modelFileUrl(modelId, model.revision, filename))),
    }))
  );
  return {
    ok: true,
    details: {
      model: modelId,
      label: model.label,
      revision: model.revision,
      approximateSize: model.approximateSize,
      custom: Boolean(model.custom),
      ready: files.every((file) => file.downloaded),
      files,
    },
  };
}

async function prepareModel(modelId) {
  const model = await getModelPolicy(modelId);
  if (!model) throw new Error("Unknown local model");
  if (await isModelReady(modelId)) {
    try {
      if (model.custom) await ensureModelPipeline(modelId, model);
      progress("ready", 100);
      return { ok: true, status: "ready" };
    } catch (error) {
      await deleteCachedModelFiles(modelId);
      await progress("error", 0, error.message);
      throw error;
    }
  }

  if (activeDownloads.has(modelId)) throw new Error("This model is already downloading");
  const downloadController = new AbortController();
  activeDownloads.set(modelId, downloadController);
  const files = Object.entries(model.files);
  let completedBytes = 0;
  progress("downloading", 0);

  try {
    await diagnosticLog("info", "model-download-started", modelId, `${files.length} allowed files`);
    const cache = await caches.open(CACHE_NAME);
    for (const [filename, expectedHash] of files) {
      const url = modelFileUrl(modelId, model.revision, filename);
      const existing = await cache.match(url);
      if (existing) continue;

      const currentProgress = Math.min(99, (completedBytes / model.approximateSize) * 100);
      const response = await fetchWithRetry(url, filename, currentProgress, downloadController.signal);
      const buffer = await readDownload(response, (received) => {
        progress("downloading", Math.min(99, ((completedBytes + received) / model.approximateSize) * 100));
      });
      if (downloadController.signal.aborted) throw new DOMException("Download cancelled", "AbortError");
      await progress("downloading", Math.min(99, ((completedBytes + buffer.byteLength) / model.approximateSize) * 100), `Verifying ${filename}…`);
      const actualHash = await sha256Hex(buffer);
      if (downloadController.signal.aborted) throw new DOMException("Download cancelled", "AbortError");
      if (expectedHash && actualHash !== expectedHash) {
        throw new Error(`Integrity verification failed for ${filename}`);
      }
      if (model.custom && !expectedHash) {
        model.files[filename] = actualHash;
        await chrome.runtime.sendMessage({
          target: "background",
          type: "update-custom-model",
          model,
        });
      }
      await cache.put(url, new Response(buffer, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }));
      completedBytes += buffer.byteLength;
      progress("downloading", Math.min(99, (completedBytes / model.approximateSize) * 100));
    }
    if (model.custom) {
      await progress("downloading", 99, "Testing model compatibility…");
      await ensureModelPipeline(modelId, model);
    }
    progress("ready", 100);
    await diagnosticLog("info", "model-download-complete", modelId, `${completedBytes} bytes cached and verified`);
    return { ok: true, status: "ready" };
  } catch (error) {
    await deleteCachedModelFiles(modelId);
    if (error?.name === "AbortError" || downloadController.signal.aborted) {
      await diagnosticLog("info", "model-download-cancelled", modelId);
      await progress("not-downloaded", 0, "Download cancelled");
      return { ok: true, status: "cancelled", cancelled: true };
    }
    const quotaFailure = error?.name === "QuotaExceededError" || /quota|storage|disk space/i.test(error?.message || "");
    const reportedError = quotaFailure
      ? new Error("The model could not be stored locally. Free disk space or grant persistent storage, then try again.")
      : error;
    progress("error", 0, reportedError.message);
    await diagnosticLog("error", "model-download-failed", modelId, runtimeErrorDetail(reportedError));
    throw reportedError;
  } finally {
    activeDownloads.delete(modelId);
  }
}

function cancelDownload(modelId) {
  const controller = activeDownloads.get(modelId);
  if (!controller) return { ok: true, cancelled: false };
  controller.abort();
  return { ok: true, cancelled: true };
}

async function deleteCachedModelFiles(modelId) {
  const model = await getModelPolicy(modelId);
  if (!model) return;
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    Object.keys(model.files).map((filename) =>
      cache.delete(modelFileUrl(modelId, model.revision, filename))
    )
  );
}

async function deleteModel(modelId) {
  if (!(await getModelPolicy(modelId))) throw new Error("Unknown local model");

  // The delete action is intentionally a factory reset for local inference.
  // Removing the entire named cache also catches files from older revisions
  // that are no longer present in the current integrity manifest.
  await progress("deleting", 10, "Stopping local model runtime…");
  loadedPipelines.clear();
  await progress("deleting", 35, "Deleting cached model files…");
  await caches.delete(CACHE_NAME);
  await progress("deleting", 70, "Cached model files deleted");
  return { ok: true };
}

async function scan(text, modelId) {
  const model = await getModelPolicy(modelId);
  if (!model) throw new Error("Unknown local model");
  if (!(await isModelReady(modelId))) throw new Error("MODEL_NOT_READY");

  const chunks = chunkText(text);
  let detector;
  let outputs;
  try {
    detector = await ensureModelPipeline(modelId, model);
    outputs = await detector(chunks.map((chunk) => chunk.text), { aggregation_strategy: "simple" });
  } catch (error) {
    loadedPipelines.delete(modelId);
    await diagnosticLog("error", "model-scan-failed", modelId, runtimeErrorDetail(error));
    throw new Error(`Local model scan failed: ${error.message || String(error)}`);
  }
  const findings = findingsFromModelOutputs({
    text,
    chunks,
    outputs,
    modelId,
    policy: detectionInstructions,
    isSingleToken: (word) => detector.tokenizer.tokenize(word).length === 1,
  });
  return {
    hasPrivateInfo: findings.some((item) => !item.weak),
    findings,
    model: modelId,
    policy: detectionInstructions.policyText,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;
  if (message.customModel?.id) customModelPolicy = message.customModel;
  const modelId = message.model || DEFAULT_MODEL;
  const task = message.type === "prepare-model"
    ? prepareModel(modelId)
    : message.type === "cancel-download"
      ? Promise.resolve(cancelDownload(modelId))
    : message.type === "delete-model"
      ? deleteModel(modelId)
      : message.type === "model-status"
        ? isModelReady(modelId).then((ready) => ({ ok: true, ready }))
        : message.type === "model-details"
          ? modelDetails(modelId)
        : message.type === "scan-message"
          ? scan(message.text, modelId).then((result) => ({ ok: true, result }))
          : Promise.reject(new Error("Unknown inference request"));
  task.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
