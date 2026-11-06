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
redacted message, send the original, or cancel. Placeholders in replies are
mapped back to the original values on the device (see Reversible placeholders).

Users can also highlight missed words in the confirmation modal, classify them
as a person, organization, location, email, phone number, or other private
information, and redact them immediately. These classifications are stored only
in `chrome.storage.local` and are applied to matching text in later messages.
Protection can be paused or resumed from the popup or directly from the privacy
confirmation modal. While paused, outgoing messages pass through without a local
scan. Selecting text in a chat composer does not open a separate popup; missed
PII classification remains available inside the confirmation modal.
### Context-aware detection

Detection combines the NER model with deterministic rules in
[detection-rules.js](./detection-rules.js). Both are filtered for context so
that ordinary messages are not interrupted:

- Phone numbers need phone formatting, an international prefix, or nearby
  context such as `call me at`; dates, versions, order numbers and timestamps
  are ignored. Payment cards must pass the Luhn check, IBANs their checksum, and
  IPv4 addresses must have valid octets.
- Secrets cover common key formats (OpenAI, Anthropic, GitHub, AWS, Google,
  Slack, Stripe, Hugging Face, JWT), high-entropy `api_`/`key_` strings, and
  values assigned to `password`, `token` or `secret`. Environment-variable
  references and placeholders such as `<your password>` are ignored. A private
  key is redacted as the whole block, not only its header.
- Technical identifiers are handled in [technical-rules.js](./technical-rules.js):
  - **Cloud:** AWS account IDs (labelled, dashed `1234-5678-9012`, or inside an
    ARN), ARNs, IAM unique IDs, EC2/VPC/subnet/security-group IDs, RDS/ELB/ECR/S3
    endpoints, `s3://` and `gs://` URIs, Azure tenant/subscription GUIDs, and GCP
    project IDs. Public AWS managed-policy ARNs (`arn:aws:iam::aws:policy/...`)
    are left alone.
  - **Credentials:** any identifier containing `secret`, `token`, `password`,
    `api_key`, `access_key`, … assigned in code, JSON, YAML or `.env` (so
    `aws_secret_access_key=...` and `"password": "..."` are caught), `Bearer` and
    `Basic` headers, secret query parameters such as `X-Amz-Signature=`, Azure
    `AccountKey=`, and an unprefixed 40-character AWS secret key sitting next to
    an access key ID. Type names (`password: string`) and references
    (`os.environ[...]`, `${SECRET}`) are ignored.
  - **URLs:** connection strings and URLs with an embedded password, internal
    hosts (`.internal`, `.corp`, `.svc.cluster.local`), and document/meeting
    links that grant access (Google Docs, Atlassian, SharePoint, Zoom, ...). Plain
    public URLs are not touched.
  - **Network:** IPv6 and MAC addresses and internal hostnames, in addition to
    IPv4. Loopback, broadcast, times (`10:30:45`) and C++ scopes (`a::b`) are
    ignored.
  - **People:** usernames inside paths (`/Users/jane/`, `C:\Users\Jane\`) with
    generic accounts such as `ubuntu` or `runner` skipped; SSNs (invalid ranges
    rejected), CNICs, labelled passport/national-ID/driver-licence numbers, and
    labelled bank account numbers.
- `I'm Momina` / `I am Momina` require a capitalized name, so `I'm happy` is not
  a name; `my name is momina` also accepts lowercase. After `working for`/`works at`,
  a capitalized employer is always accepted. A lowercase one (`working for
  unicef`) is accepted only if the loaded model's tokenizer splits it into
  pieces, which marks it as a rare word such as a name or acronym. Ordinary
  words (`working for hours`, `work at home`) are single tokens and are ignored.
- Dates are only private after birth-date labels such as `DOB`, `date of birth`,
  `born on`, or `birthday`, and are replaced with a date-of-birth placeholder.
- Model output drops `MISC` labels (languages, nationalities, events), tokenizer
  fragments inside larger words, lowercase noise, greetings, and anything
  inside Markdown code. Per-type confidence thresholds are in
  [model-prompts.js](./model-prompts.js).
- Organizations and locations count as private only when the same sentence ties
  them to a person (`I live in Lahore`, `Ali works at Acme`). Without that
  context, `Explain how Google ranks pages` does not open the confirmation
  dialog. If the dialog opens for other findings, those values are listed
  unselected.

Transformers.js does not return character offsets for token classification,
so model words are aligned to the message in reading order, preferring whole
words. Long messages are split into chunks so that text beyond the model's
512-token limit is still scanned.

### Reversible placeholders

**Send redacted** replaces each distinct value with a numbered placeholder such
as `[PERSON_1]` or `[EMAIL_2]`. The same value always gets the same placeholder
within a conversation, so the AI can still tell people apart. Only the
placeholder leaves the device.

The placeholder-to-value mapping is stored per conversation in
`chrome.storage.local`. When an **AI reply** shows a known placeholder, it is
swapped back to the original value in the page and lightly highlighted. Your own
sent messages are deliberately **not** restored: your chat bubble keeps showing
`[EMAIL_1]`, so you can see exactly what the provider received instead of having
to trust it. Editable text, such as the composer, is never changed, so restored
values cannot be sent back out by accident. This applies on ChatGPT, Claude and
Gemini (see `userMessageSelectors` in [content.js](./content.js)).

The popup setting **Show original values in AI replies** only controls this
display step. Your outgoing message is redacted either way; turning it off also
deletes the saved mappings, and replies then show the placeholders as sent. Values already mapped in a
conversation are redacted automatically if they appear in a later message.

A new chat has no conversation id until its first message is sent, so its
mapping is held as a draft and adopted by the next conversation URL that
appears within five minutes. Mappings expire 30 days after a conversation was
last used, with at most 200 conversations kept. Turning off **Show original
values in AI replies** in the popup deletes all mappings and stops saving new
ones; placeholders are still numbered within each message.

Limitations: a reply restored on screen shows the real values, so text you copy
from it contains them. If a site feature re-sends selected page text (for
example, quoting a reply), that text is checked by the normal outgoing scan.

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

The `models/` directory is a local development cache used only by the model
evaluation suite. It is not used by the browser extension and is excluded
from the Chrome Web Store package.

### Model evaluation

`npm run setup` installs dependencies, downloads the default model into
`models/` (verified against the SHA-256 manifest in `model-policy.js`), and
runs every test. `npm test` skips the model evaluation when the model has not
been downloaded.

`test/model-eval/cases.js` holds labelled messages: values that must be
redacted and look-alikes that must not be. Each case runs through the same
post-processing as the extension (`scan-pipeline.js`) on Node's ONNX runtime.

```sh
npm run models:download -- --all          # every approved model
npm run test:model                        # default model
PRIVY_EVAL_MODEL=Xenova/distilbert-base-multilingual-cased-ner-hrl npm run test:model

# A candidate that is not yet approved: download at a pinned commit, which
# prints file hashes for model-policy.js, then evaluate it.
npm run models:download -- owner/model --revision <commit>
PRIVY_EVAL_MODEL=owner/model npm run test:model
```

Cases marked `gap` are known limitations. They are reported as TODO and do
not fail the suite.
The build command creates a clean production directory without `node_modules/`
or the legacy model cache.

Never distribute Chrome-generated `.pem` files. They are private signing keys
and are excluded from the project and release package.

## Runtime files

- `content.js` intercepts sends on ChatGPT, Claude, and Gemini, and restores placeholders in replies.
- `pseudonymization.js` assigns placeholders and restores them from the local mapping.
- `detection-rules.js` contains the deterministic detectors and context filters.
- `technical-rules.js` contains the cloud, credential, URL, network, path and ID detectors.
- `background.js` coordinates extension messaging and the setup lifecycle.
- `offscreen.js` downloads, verifies, caches, and runs approved models.
- `model-policy.js` is the immutable model allowlist and integrity manifest.
- `popup.html` provides consent, selection, progress, and deletion controls.
- `models.html` shows the verified model files stored in the browser cache.
- `model-prompts.js` contains the editable detection and redaction policy.
- `vendor/` contains a self-contained executable runtime bundle and WASM files.
