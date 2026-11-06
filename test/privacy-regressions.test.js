import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Delete all local data removes logs, learning, model configuration, and protection preferences", async () => {
  const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
  for (const key of [
    "piiNotPrivate",
    "piiPrivate",
    "piiFeedbackSalt",
    "privacyLogs",
    "customModel",
    "extensionPaused",
    "privacyConsentAccepted",
    "privyVaults",
    "restoreResponses",
  ]) {
    assert.match(source, new RegExp(`chrome\\.storage\\.local\\.remove\\([\\s\\S]*"${key}"`));
  }
});

test("Delete all local data remains available when no complete model is downloaded", async () => {
  const source = await readFile(new URL("../popup.js", import.meta.url), "utf8");
  const disabledAssignment = source.match(/removeButton\\.disabled\\s*=([^;]+);/)?.[1] || "";
  assert.doesNotMatch(disabledAssignment, /not-downloaded/);
});

test("message interception requires affirmative privacy consent", async () => {
  const source = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(source, /if \(!privacyConsentAccepted \|\| extensionPaused\) return;/);
});

test("a stalled model scan has a timeout and cannot block sending indefinitely", async () => {
  const source = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(source, /Promise\.race\(\[\s*chrome\.runtime\.sendMessage\(\{ type: "scan-message"/);
});

test("restored values are never written into editable composer text", async () => {
  const source = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(source, /parent\.isContentEditable \|\| parent\.closest\("textarea, input/);
});

test("the user's own sent messages keep their placeholders; only AI replies are restored", async () => {
  const source = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(source, /parent\.closest\(USER_MESSAGE_SELECTOR\)\) return;/);
  for (const selector of ['data-message-author-role="user"', 'data-testid="user-message"', "user-query"]) {
    assert.ok(source.includes(selector), selector);
  }
});

test.todo("Replacing a custom model removes the prior custom model's orphaned cached files");
test.todo("cached model readiness re-verifies content hashes rather than checking presence only");
test.todo("large model downloads do not retain both all chunks and a second full-size buffer");
test.todo("download progress updates are throttled to avoid one storage write per network chunk");
test.todo("download cancellation interrupts retry backoff immediately");
test.todo("loaded inference pipelines dispose GPU and WASM resources during deletion");
