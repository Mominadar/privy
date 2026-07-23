import { APPROVED_MODELS, DEFAULT_MODEL } from "./model-policy.js";

const modelSelect = document.querySelector("#model");
const statusText = document.querySelector("#status");
const statusDot = document.querySelector("#dot");
const progressBar = document.querySelector("#progress");
const prepareButton = document.querySelector("#prepare");
const removeButton = document.querySelector("#remove");
const sizeText = document.querySelector("#size");
const revisionText = document.querySelector("#revision");
const integrityText = document.querySelector("#integrity");
const customModelId = document.querySelector("#custom-model-id");
const addCustomModelButton = document.querySelector("#add-custom-model");
const customModelError = document.querySelector("#custom-model-error");
let customModel = null;
let currentStatus = "not-downloaded";

if (new URLSearchParams(location.search).has("welcome")) {
  document.body.classList.add("welcome");
  document.querySelector("#title").textContent = "Set up Local Privacy Guard";
  document.querySelector("#intro").hidden = false;
}

function selectedPolicy() {
  return APPROVED_MODELS[modelSelect.value] || (customModel?.id === modelSelect.value ? customModel : null);
}

function renderModelDetails() {
  const model = selectedPolicy();
  if (!model) return;
  sizeText.textContent = `≈${Math.round(model.approximateSize / 1_000_000)} MB`;
  revisionText.textContent = `${model.revision.slice(0, 9)}…`;
  revisionText.title = model.revision;
  integrityText.textContent = model.custom ? "Verified after first download" : "SHA-256 verified";
}

function addCustomModelOption(model) {
  customModel = model;
  let option = [...modelSelect.options].find((item) => item.value === model.id);
  if (!option) {
    option = document.createElement("option");
    option.value = model.id;
    modelSelect.append(option);
  }
  option.textContent = model.label;
}

function renderStatus(status, progress = 0, error = "") {
  currentStatus = status;
  statusDot.className = "dot";
  const labels = {
    ready: "Downloaded, verified, and ready",
    downloading: error || `Downloading and verifying… ${progress}%`,
    retrying: error || `Hugging Face unavailable; retrying… ${progress}%`,
    cancelling: "Cancelling download and removing partial files…",
    deleting: error || `Deleting all local model data… ${progress}%`,
    error: error || "Download or integrity check failed",
    "not-downloaded": "Permission required to download",
  };
  statusText.textContent = labels[status] || labels["not-downloaded"];
  if (status === "ready") statusDot.classList.add("ready");
  if (status === "error") statusDot.classList.add("error");
  const downloading = status === "downloading" || status === "retrying";
  const busy = downloading || status === "cancelling" || status === "deleting";
  progressBar.classList.toggle("active", busy);
  progressBar.value = progress;
  modelSelect.disabled = busy;
  prepareButton.disabled = busy;
  removeButton.disabled = status === "cancelling" || status === "deleting" || status === "not-downloaded";
  removeButton.textContent = downloading
    ? "Cancel download"
    : status === "cancelling"
      ? "Cancelling…"
      : status === "deleting"
        ? `Deleting… ${progress}%`
        : "Delete all local model data";
}

async function ensureLocalModelCapacity(model) {
  if (!navigator.storage?.estimate) return;
  const required = Math.ceil(Number(model.approximateSize || 0) * 1.15);
  if (!required) return;
  const initial = await navigator.storage.estimate();
  const available = Math.max(0, Number(initial.quota || 0) - Number(initial.usage || 0));
  if (required <= available) return;

  const requiredMb = Math.ceil(required / 1_000_000);
  const availableMb = Math.floor(available / 1_000_000);
  const granted = window.confirm(
    `This model needs about ${requiredMb} MB, but the browser currently reports only ${availableMb} MB available.\n\n` +
    "Allow Privacy Guard to request persistent local storage for this model? The files remain on this device."
  );
  if (!granted) throw new Error("Model download cancelled: local storage permission was not granted");

  if (!navigator.storage.persist) {
    throw new Error("This browser cannot grant persistent local model storage");
  }
  const persistent = await navigator.storage.persist();
  if (!persistent) {
    throw new Error("The browser did not grant persistent local model storage");
  }
  const updated = await navigator.storage.estimate();
  const updatedAvailable = Math.max(0, Number(updated.quota || 0) - Number(updated.usage || 0));
  if (required > updatedAvailable) {
    throw new Error(
      `Not enough local disk space for this model (needs about ${requiredMb} MB; ${Math.floor(updatedAvailable / 1_000_000)} MB available)`
    );
  }
}

async function refreshActualStatus() {
  const response = await chrome.runtime.sendMessage({
    type: "model-status",
    model: modelSelect.value,
  });
  if (response?.ok) {
    const status = response.ready ? "ready" : "not-downloaded";
    await chrome.storage.local.set({ modelStatus: status, modelProgress: response.ready ? 100 : 0 });
    renderStatus(status, response.ready ? 100 : 0);
  }
}

async function prepareModel() {
  try {
    await ensureLocalModelCapacity(selectedPolicy());
    renderStatus("downloading", 0);
    await chrome.storage.local.set({ modelStatus: "downloading", modelProgress: 0 });
    const response = await chrome.runtime.sendMessage({
      type: "prepare-model",
      model: modelSelect.value,
    });
    if (!response?.ok) throw new Error(response?.error || "Model download failed");
    if (response.cancelled) renderStatus("not-downloaded", 0);
    else renderStatus("ready", 100);
  } catch (error) {
    const message = error.message || "Model download failed";
    await chrome.storage.local.set({ modelStatus: "error", modelProgress: 0, modelError: message });
    renderStatus("error", 0, message);
  }
}

async function cancelDownload() {
  const progress = Number(progressBar.value || 0);
  renderStatus("cancelling", progress);
  await chrome.storage.local.set({
    modelStatus: "cancelling",
    modelProgress: progress,
    modelError: "",
  });
  const response = await chrome.runtime.sendMessage({
    type: "cancel-download",
    model: modelSelect.value,
  });
  if (!response?.ok) {
    const error = response?.error || "Could not cancel download";
    await chrome.storage.local.set({ modelStatus: "error", modelProgress: 0, modelError: error });
    renderStatus("error", 0, error);
  }
}

async function deleteModel() {
  renderStatus("deleting", 0, "Preparing clean deletion…");
  await chrome.storage.local.set({
    modelStatus: "deleting",
    modelProgress: 0,
    modelError: "Preparing clean deletion…",
  });
  try {
    const response = await chrome.runtime.sendMessage({
      type: "delete-model",
      model: modelSelect.value,
    });
    if (!response?.ok) {
      const error = response?.error || "Deletion failed";
      await chrome.storage.local.set({ modelStatus: "error", modelProgress: 0, modelError: error });
      renderStatus("error", 0, error);
    } else {
      customModel = null;
      [...modelSelect.options].filter((option) => option.value !== DEFAULT_MODEL && !APPROVED_MODELS[option.value])
        .forEach((option) => option.remove());
      modelSelect.value = DEFAULT_MODEL;
      renderModelDetails();
      renderStatus("not-downloaded", 0);
    }
  } catch (error) {
    const message = error.message || "Deletion failed";
    await chrome.storage.local.set({ modelStatus: "error", modelProgress: 0, modelError: message });
    renderStatus("error", 0, message);
  }
}

async function initialize() {
  const stored = await chrome.storage.local.get(["selectedModel", "customModel", "modelStatus", "modelProgress", "modelError"]);
  if (stored.customModel) addCustomModelOption(stored.customModel);
  modelSelect.value = APPROVED_MODELS[stored.selectedModel] || stored.customModel?.id === stored.selectedModel
    ? stored.selectedModel
    : DEFAULT_MODEL;
  renderModelDetails();
  renderStatus(stored.modelStatus, stored.modelProgress, stored.modelError);
  if (!["deleting", "downloading", "retrying", "cancelling"].includes(stored.modelStatus)) {
    await refreshActualStatus();
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.modelStatus || changes.modelProgress || changes.modelError) {
    chrome.storage.local.get(["modelStatus", "modelProgress", "modelError"]).then((state) =>
      renderStatus(state.modelStatus, state.modelProgress, state.modelError)
    );
  }
});

modelSelect.addEventListener("change", async () => {
  await chrome.storage.local.set({ selectedModel: modelSelect.value });
  renderModelDetails();
  await refreshActualStatus();
});
prepareButton.addEventListener("click", prepareModel);
removeButton.addEventListener("click", () => {
  if (currentStatus === "downloading" || currentStatus === "retrying") void cancelDownload();
  else void deleteModel();
});
addCustomModelButton.addEventListener("click", async () => {
  customModelError.textContent = "";
  addCustomModelButton.disabled = true;
  addCustomModelButton.textContent = "Checking repository…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "register-custom-model",
      model: customModelId.value,
    });
    if (!response?.ok) throw new Error(response?.error || "Could not add model");
    await chrome.storage.local.set({
      customModel: response.model,
      selectedModel: response.model.id,
      modelStatus: "not-downloaded",
      modelProgress: 0,
      modelError: "",
    });
    addCustomModelOption(response.model);
    modelSelect.value = response.model.id;
    renderModelDetails();
    renderStatus("not-downloaded", 0);
  } catch (error) {
    customModelError.textContent = error.message || "Could not add model";
  } finally {
    addCustomModelButton.disabled = false;
    addCustomModelButton.textContent = "Validate and select model";
  }
});
void initialize();
