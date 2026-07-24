import { DEFAULT_MODEL, getApprovedModel, isValidHuggingFaceModelId } from "./model-policy.js";

const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreen;
const CUSTOM_MODEL_BASE_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
];
const CUSTOM_ONNX_VARIANTS = [
  { filename: "onnx/model_q4.onnx", dtype: "q4" },
  { filename: "onnx/model_quantized.onnx", dtype: "q8" },
  { filename: "onnx/model_q4f16.onnx", dtype: "q4f16" },
  { filename: "onnx/model_fp16.onnx", dtype: "fp16" },
  { filename: "onnx/model.onnx", dtype: "fp32" },
];
const MAX_LOCAL_LOGS = 300;
let logWriteChain = Promise.resolve();

function appendLog({ level = "info", event = "runtime", detail = "", model = "" } = {}) {
  const write = async () => {
    const { privacyLogs = [] } = await chrome.storage.local.get("privacyLogs");
    privacyLogs.push({
      timestamp: new Date().toISOString(),
      level: String(level).slice(0, 16),
      event: String(event).slice(0, 80),
      detail: String(detail).slice(0, 2000),
      model: String(model).slice(0, 200),
    });
    await chrome.storage.local.set({ privacyLogs: privacyLogs.slice(-MAX_LOCAL_LOGS) });
  };
  logWriteChain = logWriteChain.then(write, write);
  return logWriteChain;
}

async function registerCustomModel(modelId) {
  const id = String(modelId || "").trim();
  if (!isValidHuggingFaceModelId(id)) {
    throw new Error("Enter a Hugging Face model ID in owner/model format");
  }
  const apiId = id.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`https://huggingface.co/api/models/${apiId}?blobs=true`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not read Hugging Face model metadata (HTTP ${response.status})`);
  const metadata = await response.json();
  if (metadata.pipeline_tag !== "token-classification") {
    throw new Error("The repository must be a token-classification model");
  }
  if (!/^[a-f0-9]{40}$/i.test(metadata.sha || "")) {
    throw new Error("Hugging Face did not provide an immutable model revision");
  }
  const siblings = new Map((metadata.siblings || []).map((file) => [file.rfilename, file]));
  const missing = CUSTOM_MODEL_BASE_FILES.filter((filename) => !siblings.has(filename));
  if (missing.length) {
    throw new Error(`Model is not browser-compatible; missing ${missing.join(", ")}`);
  }
  const variant = CUSTOM_ONNX_VARIANTS.find(({ filename }) => siblings.has(filename));
  if (!variant) {
    throw new Error("Model is not browser-compatible; no supported ONNX model variant was found");
  }
  const externalPrefix = `${variant.filename}_data`;
  const externalFiles = [...siblings.keys()]
    .filter((filename) => filename === externalPrefix || filename.startsWith(`${externalPrefix}_`))
    .sort();
  const optionalFiles = siblings.has("viterbi_calibration.json") ? ["viterbi_calibration.json"] : [];
  const modelFiles = [...CUSTOM_MODEL_BASE_FILES, variant.filename, ...externalFiles, ...optionalFiles];
  const approximateSize = modelFiles.reduce((sum, filename) =>
    sum + Number(siblings.get(filename)?.size || siblings.get(filename)?.lfs?.size || 0), 0
  );
  const customModel = {
    id,
    label: `${id} (custom)`,
    revision: metadata.sha,
    approximateSize: approximateSize || 100_000_000,
    files: Object.fromEntries(modelFiles.map((filename) => [filename, null])),
    dtype: variant.dtype,
    device: metadata.config?.model_type === "openai_privacy_filter" ? "webgpu" : "wasm",
    modelType: metadata.config?.model_type || "",
    custom: true,
  };
  return { ok: true, model: customModel };
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (existing.length) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["WORKERS"],
        justification: "Run a user-approved privacy model locally in the browser",
      })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function sendToInference(message) {
  await ensureOffscreenDocument();
  const { customModel } = await chrome.storage.local.get("customModel");
  const request = { ...message, target: "offscreen", customModel };
  try {
    return await chrome.runtime.sendMessage(request);
  } catch (error) {
    if (!error.message?.includes("Receiving end does not exist")) throw error;
    // A freshly-created offscreen module may still be registering its listener.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return chrome.runtime.sendMessage(request);
  }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { selectedModel, customModel } = await chrome.storage.local.get(["selectedModel", "customModel"]);
  if (!getApprovedModel(selectedModel) && customModel?.id !== selectedModel) {
    await chrome.storage.local.set({
      selectedModel: DEFAULT_MODEL,
      modelStatus: "not-downloaded",
      modelProgress: 0,
    });
  }
  if (reason === "install") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?welcome=1") });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === "offscreen") return false;

  if (message?.target === "background" && message.type === "model-progress") {
    chrome.storage.local.set({
      modelStatus: message.status,
      modelProgress: message.progress,
      modelError: message.error || "",
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.target === "background" && message.type === "update-custom-model") {
    chrome.storage.local.set({ customModel: message.model })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.target === "background" && message.type === "log-event") {
    appendLog(message.entry)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === "open-logs") {
    chrome.tabs.create({ url: chrome.runtime.getURL("logs.html") })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "register-custom-model") {
    registerCustomModel(message.model)
      .then(async (response) => {
        await appendLog({ event: "custom-model-validated", model: response.model.id, detail: `Pinned revision ${response.model.revision}` });
        sendResponse(response);
      })
      .catch(async (error) => {
        await appendLog({ level: "error", event: "custom-model-validation-failed", model: message.model, detail: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (!["prepare-model", "cancel-download", "scan-message", "delete-model", "model-status", "model-details"].includes(message?.type)) {
    return false;
  }

  sendToInference(message)
    .then(async (response) => {
      if (message.type === "delete-model" && response?.ok) {
        await chrome.storage.local.set({
          modelStatus: "deleting",
          modelProgress: 85,
          modelError: "Clearing local learning…",
        });
        await chrome.storage.local.remove([
          "piiNotPrivate",
          "piiPrivate",
          "piiFeedbackSalt",
          "privacyLogs",
          "customModel",
          "modelError",
          "extensionPaused",
          "privacyConsentAccepted",
        ]);
        await chrome.storage.local.set({
          selectedModel: DEFAULT_MODEL,
          modelStatus: "not-downloaded",
          modelProgress: 0,
        });
        // Do not block deletion completion on Chrome tearing down the runtime.
        void chrome.offscreen.closeDocument().catch(() => {});
      }
      sendResponse(response);
    })
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
