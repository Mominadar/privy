import { copyFile, mkdir, rm } from "node:fs/promises";

const output = "dist-extension";
const files = [
  "manifest.json",
  "background.js",
  "content.js",
  "entity-normalization.js",
  "model-policy.js",
  "model-prompts.js",
  "models.html",
  "models.css",
  "models.js",
  "logs.html",
  "logs.css",
  "logs.js",
  "offscreen.html",
  "offscreen.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "platform-icons/chatgpt.svg",
  "platform-icons/claude.svg",
  "platform-icons/gemini.svg",
];
const vendorFiles = [
  "transformers.bundle.js",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
];

await rm(output, { recursive: true, force: true });
await mkdir(`${output}/vendor`, { recursive: true });
await mkdir(`${output}/icons`, { recursive: true });
await mkdir(`${output}/platform-icons`, { recursive: true });
await Promise.all(files.map((file) => copyFile(file, `${output}/${file}`)));
await Promise.all(vendorFiles.map((file) => copyFile(`vendor/${file}`, `${output}/vendor/${file}`)));
console.log(`Production extension assembled in ${output}/`);
