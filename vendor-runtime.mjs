import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const runtimeSource = "node_modules/onnxruntime-web/dist";
const destination = "vendor";

await mkdir(destination, { recursive: true });
await build({
  entryPoints: ["browser-runtime-entry.js"],
  outfile: `${destination}/transformers.bundle.js`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome116",
  minify: true,
  sourcemap: false,
  conditions: ["browser", "import", "default"],
});

await Promise.all([
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
].map((file) => copyFile(`${runtimeSource}/${file}`, `${destination}/${file}`)));

console.log("Bundled the self-contained browser inference runtime in vendor/.");
