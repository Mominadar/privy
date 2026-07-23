const output = document.querySelector("#logs");
const downloadButton = document.querySelector("#download");
const clearButton = document.querySelector("#clear");

function formatLogs(logs) {
  if (!logs.length) return "No diagnostic events recorded.";
  return logs.map((entry) =>
    `[${entry.timestamp}] ${String(entry.level || "info").toUpperCase()} ${entry.event}` +
    `${entry.model ? ` model=${entry.model}` : ""}` +
    `${entry.detail ? `\n  ${entry.detail}` : ""}`
  ).join("\n\n");
}

async function readLogs() {
  const { privacyLogs = [] } = await chrome.storage.local.get("privacyLogs");
  const text = formatLogs(privacyLogs);
  output.textContent = text;
  return text;
}

downloadButton.addEventListener("click", async () => {
  const text = await readLogs();
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `privacy-guard-logs-${new Date().toISOString().replaceAll(":", "-")}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

clearButton.addEventListener("click", async () => {
  await chrome.storage.local.remove("privacyLogs");
  await readLogs();
});

void readLogs();
