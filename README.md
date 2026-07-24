# Privy Local Privacy Guard

A browser-only Chrome extension that checks ChatGPT, Claude, and Gemini
messages locally before they are sent. It does not require Node.js, a localhost
server, or a companion application after the extension has been packaged.

## Production behavior

1. Installation opens a setup page.
2. The user accepts an in-product privacy disclosure, selects a model, and
   explicitly clicks download.
3. The extension downloads only pinned model data from Hugging Face.
4. Every file is SHA-256 verified before entering the trusted browser cache.
5. A bundled Transformers.js + ONNX/WASM runtime performs inference locally.
6. Messages never leave the device for privacy scanning.

Users may alternatively enter a public Hugging Face repository ID. Custom
repositories must declare the `token-classification` pipeline and contain
`config.json`, `tokenizer.json`, `tokenizer_config.json`, and a supported ONNX
variant. The extension resolves the repository to its
immutable commit before downloading. Only those data files are accepted;
repository scripts and custom executable code are never loaded. Because a
custom repository has no bundled trust manifest, its files are SHA-256 hashed
on first download and that local manifest is used for subsequent verification.
Before a custom download is marked ready, the extension initializes its
token-classification pipeline as a compatibility smoke test. Unsupported model
architectures or invalid ONNX/tokenizer combinations are rejected immediately
and their cached files are removed instead of failing later when a message is
sent.
Custom registration prefers q4, followed by q8, q4f16, fp16, and fp32. Every
external ONNX data shard and an available Viterbi calibration file is included
in the verified cache. Models that require WebGPU, including
`openai/privacy-filter`, use that backend instead of the default WASM path.
Transformers.js repository URL resolution is backed by a cache-only fetch
adapter. The runtime can read verified allowlisted responses using either its
local-path or Hugging Face URL key, but the adapter returns a local 404 for
uncached or non-allowlisted resources and never performs a network request.
Before downloading, the popup compares the model size (plus working overhead)
with the browser's reported available storage. If it will not fit, the user is
asked before the extension requests persistent local storage. The download
continues only after permission and a successful capacity recheck; otherwise a
clear local-storage or disk-space error is shown. Model files remain on-device
in the extension's private Cache Storage.
An active download can be cancelled from the popup. Cancellation aborts the
network stream, removes partial files, and returns the model to its
not-downloaded state. Downloads that receive no body data for 60 seconds fail
with a clear stalled-download error rather than remaining active indefinitely.

Privacy-safe diagnostics for model validation, downloading, pipeline startup,
and scanning are retained locally (up to 300 events). Message text and detected
values are never logged. Scan failures expose a collapsed **Technical details**
section with a link to the local log viewer, where users can view, clear, or
export the log as a text file.

The popup links to a device-model page showing which approved model files are
stored, their pinned revisions, and their expected SHA-256 hashes. When a scan
finds PII, a confirmation modal displays the complete message with detected
text highlighted. Users can select individual findings and send a placeholder-
redacted message, send the original, or cancel.

Users can also highlight missed words in the confirmation modal, classify them
as a person, organization, location, email, phone number, or other private
information, and redact them immediately. These classifications are stored only
in `chrome.storage.local` and are applied to matching text in later messages.
Protection can be paused or resumed from the popup or directly from the privacy
confirmation modal. While paused, outgoing messages pass through without a local
scan. Selecting text in a chat composer does not open a separate popup; missed
PII classification remains available inside the confirmation modal.
Contextual dates following labels such as `DOB`, `date of birth`, `born on`, or
`birthday` are detected and replaced with `[DATE_OF_BIRTH]`.
Deterministic contextual rules also cover self-introductions such as `I'm
Momina`, `I am Momina`, or `my name is Momina`, plus employment phrases such as
`working for UNICEF`. These rules catch common lowercase introductions even
when a probabilistic NER model scores them below its confidence threshold.

The editable local detection policy, confidence threshold, and placeholder map
are in [model-prompts.js](./model-prompts.js). The included NER
models are classifiers and do not accept a generative text prompt; the policy
file controls their local post-processing behavior.

Marking a finding as **Not PII** adds a salted hash to `chrome.storage.local`.
The original value is not stored, and matching future false positives are
suppressed locally. This is adaptive exception memory, not model-weight
retraining. Users can clear it from the device-model page. Deleting local model
data performs a clean reset: it closes the local inference context, deletes the
entire verified-model cache (including files from older revisions), and removes
all adaptive memory, diagnostic logs, consent state, pause state, and
custom-model configuration. A later download therefore fetches and verifies
fresh model files and starts with no learned feedback.

Positive user classifications retain the selected text and category locally so
future occurrences can be recognized. They are bounded to the 500 most recent
entries. This adaptive memory changes local post-processing rules; it does not
modify the downloaded model weights.

Adjacent tokenizer pieces with the same entity type are combined using their
original character offsets before display or redaction. For example, `ever`
and `green` at adjacent offsets are presented as one `evergreen` finding.

Downloads are restricted by [model-policy.js](./model-policy.js) to:

- `Xenova/bert-base-NER` at revision
  `24c7e5aba9ae350923357a6f0b92571be34037ec` (approximately 105 MB)
- `Xenova/distilbert-base-multilingual-cased-ner-hrl` at revision
  `c2a4dbf593c57f47004c5bc2d3770d311aee9c43` (approximately 132 MB)

The policy permits only the quantized ONNX weights, tokenizer, tokenizer
configuration, and model configuration. JavaScript, WebAssembly, Python, and
custom model code cannot be downloaded by the model loader.

## Development

```sh
npm install
npm run vendor
npm run check
npm run build
```

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
and select `dist-extension/`. Reload the extension after rebuilding.

The `models/` directory is a legacy development cache and is not used by the
browser extension. It should not be included in the Chrome Web Store package.
The build command creates a clean production directory without `node_modules/`
or the legacy model cache.

Never distribute Chrome-generated `.pem` files. They are private signing keys
and are excluded from the project and release package.

## Runtime files

- `content.js` intercepts ChatGPT sends.
- `background.js` coordinates extension messaging and the setup lifecycle.
- `offscreen.js` downloads, verifies, caches, and runs approved models.
- `model-policy.js` is the immutable model allowlist and integrity manifest.
- `popup.html` provides consent, selection, progress, and deletion controls.
- `models.html` shows the verified model files stored in the browser cache.
- `model-prompts.js` contains the editable detection and redaction policy.
- `vendor/` contains a self-contained executable runtime bundle and WASM files.
