import { APPROVED_MODELS } from "./model-policy.js";

const container = document.querySelector("#models");
const feedbackCount = document.querySelector("#feedback-count");
const clearFeedback = document.querySelector("#clear-feedback");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderModel(details) {
  const card = element("article", "card");
  const head = element("div", "card-head");
  const identity = element("div");
  identity.append(element("h2", "", details.label), element("div", "repo", details.model));
  const badge = element("span", `badge${details.ready ? " ready" : ""}`, details.ready ? "Downloaded" : "Not downloaded");
  head.append(identity, badge);

  const facts = element("div", "facts");
  const revision = element("div", "fact");
  revision.append(element("span", "", "Pinned revision"), element("code", "", details.revision));
  const size = element("div", "fact");
  size.append(element("span", "", "Approximate size"), element("code", "", `${Math.round(details.approximateSize / 1_000_000)} MB`));
  facts.append(revision, size);

  const table = element("table");
  const header = document.createElement("thead");
  header.innerHTML = "<tr><th>File</th><th>Status</th><th class=\"hash\">Expected SHA-256</th></tr>";
  const body = document.createElement("tbody");
  for (const file of details.files) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.append(element("code", "", file.filename));
    const statusCell = element("td", file.downloaded ? "yes" : "no", file.downloaded ? "Stored locally" : "Missing");
    const hashCell = element("td", "hash");
    hashCell.append(element("code", "", file.sha256 || "Recorded on first download"));
    row.append(nameCell, statusCell, hashCell);
    body.append(row);
  }
  table.append(header, body);

  const source = document.createElement("a");
  source.href = `https://huggingface.co/${details.model}/tree/${details.revision}`;
  source.target = "_blank";
  source.rel = "noreferrer";
  source.textContent = "View pinned source on Hugging Face";
  card.append(head, facts, table, source);
  return card;
}

async function initialize() {
  const { piiNotPrivate = {}, piiPrivate = [], customModel } = await chrome.storage.local.get(["piiNotPrivate", "piiPrivate", "customModel"]);
  feedbackCount.textContent = Object.keys(piiNotPrivate).length + piiPrivate.length;
  const modelIds = [...Object.keys(APPROVED_MODELS), ...(customModel ? [customModel.id] : [])];
  const results = await Promise.all(modelIds.map((model) =>
    chrome.runtime.sendMessage({ type: "model-details", model })
  ));
  container.replaceChildren();
  for (const result of results) {
    if (result?.ok) container.append(renderModel(result.details));
    else container.append(element("p", "no", result?.error || "Could not read the local model cache."));
  }
}

clearFeedback.addEventListener("click", async () => {
  await chrome.storage.local.remove(["piiNotPrivate", "piiPrivate", "piiFeedbackSalt"]);
  feedbackCount.textContent = "0";
});

initialize().catch((error) => {
  container.replaceChildren(element("p", "no", error.message));
});
