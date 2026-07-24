# Chrome Web Store submission

## Store listing

**Name:** Privy Local Privacy Guard

**Summary:** Detect and redact private information locally before sending messages on supported AI chat sites.

**Single purpose:** Privy Local Privacy Guard helps users identify and optionally redact personally identifiable or otherwise private information from outgoing messages on ChatGPT, Claude, and Gemini. Detection runs locally with a user-downloaded model.

**Detailed description:**

Privy Local Privacy Guard checks outgoing messages for names, organizations,
locations, dates of birth, email addresses, phone numbers, payment-card
candidates, IP addresses, API keys, and private keys before they are sent.

- Detection and redaction happen locally in Chrome.
- The user chooses whether to send a redacted message, the original, or nothing.
- Users can classify missed private text and remember false positives locally.
- Protection can be paused or resumed at any time.
- Models are downloaded only after explicit user action.
- Message text and detection results are not sent to the publisher or Hugging Face.

Supported sites: ChatGPT, Claude, and Gemini.

## Permission justifications

- **storage:** Stores the selected model, consent and pause preferences, bounded local feedback, model status, and up to 300 local diagnostic events.
- **unlimitedStorage:** Locally cached ONNX model files can exceed Chrome's normal extension storage quota.
- **offscreen:** Runs the bundled Transformers.js and ONNX/WASM inference runtime outside the popup so local scans can complete when the popup is closed.
- **huggingface.co / hf.co host access:** Retrieves public model metadata and model data files only after user action. Outgoing messages and detection results are never included.
- **ChatGPT, Claude, and Gemini site access:** Reads the outgoing composer and intercepts its send action solely to perform the user-facing local privacy check.

## Privacy-practices answers

Declare that the extension handles:

- Website content
- Form data
- Personal communications
- Personally identifiable information
- Authentication information only if users may place credentials or API keys in a message
- Financial/payment information only if users may place payment-card data in a message

The data is processed locally to provide the extension's single purpose. It is
not sold, used for advertising, used for lending/credit decisions, or transferred
to the publisher. Model-download requests are sent to Hugging Face without
message content.

Use the hosted version of `privacy.html` as the dashboard privacy-policy URL.
Replace its contact placeholder before hosting.

## Reviewer notes

1. Open the extension popup and accept the local-processing disclosure.
2. Select an approved model and click **Download selected model**.
3. Open ChatGPT, Claude, or Gemini and refresh the page after installing the extension.
4. Send a test message such as `My name is Example Person and my email is example@example.com`.
5. The privacy confirmation modal should offer original, redacted, and cancel actions.

All executable code is packaged with the extension. Hugging Face downloads are
limited to pinned configuration, tokenizer, and ONNX weight data. Repository
scripts and remote executable code are not loaded. Runtime model access is
cache-only after verified download.

## Assets still required

- At least one store screenshot showing the popup
- At least one screenshot showing the redaction confirmation modal
- Optional promotional image
- Public support URL or support email
- Publicly hosted privacy-policy URL
- Final publisher/organization name and contact details
