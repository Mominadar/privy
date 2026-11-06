(() => {
  "use strict";

  const instructions = globalThis.PrivyModelPrompts;
  const pseudo = globalThis.PrivyPseudonymization;
  const MAX_LOCAL_FEEDBACK = 500;
  const SCAN_TIMEOUT_MS = 120_000;
  const VAULT_STORAGE_KEY = "privyVaults";
  const VAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_VAULTS = 200;
  // A new chat has no URL id until the first message is sent; its mapping is
  // stored as a draft and adopted by the conversation id that appears next.
  const DRAFT_ADOPTION_WINDOW_MS = 5 * 60 * 1000;
  const SITE_ADAPTERS = {
    "chatgpt.com": {
      name: "ChatGPT",
      composerSelectors: [
        "#prompt-textarea",
        'textarea[data-testid="prompt-textarea"]',
        'textarea[placeholder*="Message"]',
      ],
      userMessageSelectors: ['[data-message-author-role="user"]'],
    },
    "chat.openai.com": {
      name: "ChatGPT",
      composerSelectors: ["#prompt-textarea", 'textarea[data-testid="prompt-textarea"]'],
      userMessageSelectors: ['[data-message-author-role="user"]'],
    },
    "claude.ai": {
      name: "Claude",
      composerSelectors: [
        '[contenteditable="true"][data-testid="chat-input"]',
        '.ProseMirror[contenteditable="true"]',
        '[contenteditable="true"][aria-label*="write" i]',
      ],
      userMessageSelectors: ['[data-testid="user-message"]'],
    },
    "gemini.google.com": {
      name: "Gemini",
      composerSelectors: [
        'rich-textarea .ql-editor[contenteditable="true"]',
        '.ql-editor[contenteditable="true"]',
        '[contenteditable="true"][aria-label*="prompt" i]',
      ],
      userMessageSelectors: ["user-query", '[class*="user-query"]'],
    },
  };
  const siteAdapter = SITE_ADAPTERS[location.hostname] || SITE_ADAPTERS["chatgpt.com"];
  let bypassNextSend = false;
  let scanInProgress = false;
  let extensionPaused = false;
  let privacyConsentAccepted = false;
  let restoreResponses = true;
  let vaults = {};

  chrome.storage.local.get(["extensionPaused", "privacyConsentAccepted", "restoreResponses", VAULT_STORAGE_KEY]).then((stored) => {
    extensionPaused = Boolean(stored.extensionPaused);
    privacyConsentAccepted = Boolean(stored.privacyConsentAccepted);
    restoreResponses = stored.restoreResponses !== false;
    vaults = stored[VAULT_STORAGE_KEY] || {};
    scheduleFullRestore();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.extensionPaused) {
      extensionPaused = Boolean(changes.extensionPaused.newValue);
    }
    if (changes.privacyConsentAccepted) {
      privacyConsentAccepted = Boolean(changes.privacyConsentAccepted.newValue);
    }
    if (changes.restoreResponses) {
      restoreResponses = changes.restoreResponses.newValue !== false;
      scheduleFullRestore();
    }
    if (changes[VAULT_STORAGE_KEY]) {
      vaults = changes[VAULT_STORAGE_KEY].newValue || {};
      scheduleFullRestore();
    }
  });

  function findComposer() {
    for (const selector of siteAdapter.composerSelectors) {
      const composer = document.querySelector(selector);
      if (composer && isVisible(composer)) return composer;
    }
    const fallbackSelectors = [
      'main textarea:not([disabled])',
      'main [contenteditable="true"][role="textbox"]',
      'main [contenteditable="true"]',
      'textarea:not([disabled])',
      '[contenteditable="true"][role="textbox"]',
    ];
    for (const selector of fallbackSelectors) {
      const composer = [...document.querySelectorAll(selector)].find(isVisible);
      if (composer) return composer;
    }
    return null;
  }

  function isVisible(element) {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function readMessage(composer) {
    if (!composer) return "";
    if (composer instanceof HTMLTextAreaElement) return composer.value.trim();
    return (composer.innerText || composer.textContent || "").trim();
  }

  function findSendButton(target = null) {
    if (target) {
      const clickedButton = target.closest?.("button");
      if (isSendButton(clickedButton)) {
        return clickedButton;
      }
      return null;
    }
    const composer = findComposer();
    const searchRoot = composer?.closest("form") || document;
    return [...searchRoot.querySelectorAll("button")].find(isSendButton) ||
      [...document.querySelectorAll("button")].find(isSendButton) ||
      null;
  }

  function isSendButton(button) {
    if (!button) return false;
    const testId = button.getAttribute("data-testid")?.toLowerCase() || "";
    const label = button.getAttribute("aria-label")?.toLowerCase() || "";
    const tooltip = button.getAttribute("data-tooltip")?.toLowerCase() || "";
    return (
      testId === "send-button" ||
      testId === "send-message" ||
      label === "send" ||
      label.startsWith("send message") ||
      tooltip.startsWith("send message") ||
      button.classList.contains("send-button")
    );
  }

  async function scanMessage(text, vault) {
    const { selectedModel } = await chrome.storage.local.get("selectedModel");
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(
        `Local scan did not finish within ${SCAN_TIMEOUT_MS / 1000} seconds`
      )), SCAN_TIMEOUT_MS);
    });
    const response = await Promise.race([
      chrome.runtime.sendMessage({ type: "scan-message", text, model: selectedModel }),
      timeout,
    ]).finally(() => clearTimeout(timer));
    if (!response?.ok) throw new Error(response?.error || "Local scan failed");
    await chrome.storage.local.set({ modelStatus: "ready" });
    return applyLocalFeedback(response.result, text, vault);
  }

  function normalizeFeedbackValue(finding) {
    return `${finding.type}:${String(finding.value).trim().toLocaleLowerCase()}`;
  }

  function randomSalt() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes));
  }

  async function feedbackHash(finding, salt) {
    const bytes = new TextEncoder().encode(`${salt}:${normalizeFeedbackValue(finding)}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function feedbackState() {
    const stored = await chrome.storage.local.get(["piiFeedbackSalt", "piiNotPrivate", "piiPrivate"]);
    const salt = stored.piiFeedbackSalt || randomSalt();
    if (!stored.piiFeedbackSalt) await chrome.storage.local.set({ piiFeedbackSalt: salt });
    return { salt, entries: stored.piiNotPrivate || {}, privateEntries: stored.piiPrivate || [] };
  }

  function learnedPrivateFindings(message, privateEntries) {
    return privateEntries.flatMap((entry) => {
      const value = String(entry.value || "").trim();
      return pseudo.findWholeWord(message, value).map((start) => ({
        type: entry.type || "PRIVATE_ENTITY",
        value: message.slice(start, start + value.length),
        source: "local-user-classification",
        score: 1,
        start,
        end: start + value.length,
      }));
    });
  }

  async function applyLocalFeedback(result, message, vault) {
    const { salt, entries, privateEntries } = await feedbackState();
    const combined = [
      ...result.findings,
      ...learnedPrivateFindings(message, privateEntries),
      ...pseudo.vaultFindings(message, vault),
    ];
    const keep = await Promise.all(combined.map(async (finding) =>
      !entries[await feedbackHash(finding, salt)]
    ));
    const findings = combined.filter((_finding, index) => keep[index]);
    return { ...result, findings, hasPrivateInfo: findings.some((finding) => !finding.weak) };
  }

  async function rememberNotPrivate(finding) {
    const { salt, entries } = await feedbackState();
    entries[await feedbackHash(finding, salt)] = Date.now();
    const trimmed = Object.fromEntries(
      Object.entries(entries)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_LOCAL_FEEDBACK)
    );
    await chrome.storage.local.set({ piiNotPrivate: trimmed });
  }

  async function rememberPrivate(value, type) {
    const stored = await chrome.storage.local.get("piiPrivate");
    const normalized = value.trim().toLocaleLowerCase();
    const withoutDuplicate = (stored.piiPrivate || []).filter((entry) =>
      !(String(entry.value).trim().toLocaleLowerCase() === normalized && entry.type === type)
    );
    withoutDuplicate.unshift({ value: value.trim(), type, updatedAt: Date.now() });
    await chrome.storage.local.set({ piiPrivate: withoutDuplicate.slice(0, MAX_LOCAL_FEEDBACK) });
  }

  function findingRanges(message, findings, includedIndexes = null) {
    const ranges = [];
    findings.forEach((finding, index) => {
      if (includedIndexes && !includedIndexes.has(index)) return;
      const value = String(finding.value || "");
      if (!value) return;
      if (
        Number.isInteger(finding.start) &&
        Number.isInteger(finding.end) &&
        finding.start >= 0 &&
        finding.end <= message.length &&
        finding.end > finding.start
      ) {
        ranges.push({
          start: finding.start,
          end: finding.end,
          types: new Set([finding.type]),
          indexes: new Set([index]),
        });
        return;
      }
      for (const start of pseudo.findWholeWord(message, value)) {
        ranges.push({
          start,
          end: start + value.trim().length,
          types: new Set([finding.type]),
          indexes: new Set([index]),
        });
      }
    });
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    return ranges.reduce((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
        range.types.forEach((type) => previous.types.add(type));
        range.indexes.forEach((index) => previous.indexes.add(index));
      } else {
        merged.push(range);
      }
      return merged;
    }, []);
  }

  function appendHighlightedMessage(container, message, findings, selected, active = null) {
    container.replaceChildren();
    const ranges = findingRanges(message, findings, active);
    let cursor = 0;
    for (const range of ranges) {
      if (range.start > cursor) container.append(document.createTextNode(message.slice(cursor, range.start)));
      const mark = document.createElement("mark");
      mark.textContent = message.slice(range.start, range.end);
      mark.title = [...range.types].join(", ");
      mark.className = [...range.indexes].some((index) => selected.has(index)) ? "selected" : "detected";
      container.append(mark);
      cursor = range.end;
    }
    if (cursor < message.length) container.append(document.createTextNode(message.slice(cursor)));
  }

  /** Replaces selected findings with numbered tokens, recording them in `vault`. */
  function redactedMessage(message, findings, selected, vault) {
    const ranges = findingRanges(message, findings, selected)
      .map((range) => ({ start: range.start, end: range.end, type: [...range.types][0] }));
    return pseudo.pseudonymize(message, ranges, vault, instructions.placeholders);
  }

  function showPrivacyModal(message, result, vault) {
    return new Promise((resolve) => {
      const findings = [...result.findings];
      const active = new Set(findings.map((_finding, index) => index));
      // Context-free organizations and locations are listed but not pre-selected.
      const selected = new Set([...active].filter((index) => !findings[index].weak));
      const host = document.createElement("div");
      host.id = "privy-pii-confirmation";
      const shadow = host.attachShadow({ mode: "closed" });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          .backdrop { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 20px; background: rgba(0,0,0,.68); font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #17201c; }
          .modal { width: min(720px, calc(100vw - 40px)); max-height: min(820px, calc(100vh - 40px)); overflow: auto; box-sizing: border-box; padding: 24px; border-radius: 16px; background: #fff; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
          h2 { margin: 0 0 8px; font-size: 21px; line-height: 1.3; }
          .lead { margin: 0 0 16px; color: #516159; font-size: 14px; line-height: 1.5; }
          .message-label { margin: 14px 0 6px; color: #516159; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
          .message { padding: 16px; border: 1px solid #d8e0dc; border-radius: 10px; background: #f6f8f7; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.65; }
          .redacted-preview { border-color: #b9d9ca; background: #f2faf6; color: #214b37; }
          mark { padding: 1px 3px; border-radius: 4px; color: #63350b; background: #ffe7a3; }
          mark.selected { color: #8b1717; background: #ffd2d2; box-shadow: 0 0 0 1px #f4aaaa; }
          .hint { margin: 8px 0 14px; color: #697870; font-size: 11px; }
          details { margin: 10px 0; border: 1px solid #d8e0dc; border-radius: 10px; background: #fff; overflow: hidden; }
          summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; color: #2a3932; font-size: 13px; font-weight: 700; cursor: pointer; list-style: none; }
          summary::-webkit-details-marker { display: none; }
          summary::after { content: "›"; color: #65746c; font-size: 22px; font-weight: 400; line-height: 1; transition: transform .15s ease; }
          details[open] summary { border-bottom: 1px solid #e1e7e4; }
          details[open] summary::after { transform: rotate(90deg); }
          .summary-meta { margin-left: auto; color: #697870; font-size: 11px; font-weight: 500; }
          .classify { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; padding: 12px 14px 14px; background: #f2faf6; }
          .classify span { flex: 1 1 100%; color: #526159; font-size: 11px; }
          .selection-input { box-sizing: border-box; width: 100%; min-height: 76px; padding: 9px; resize: vertical; border: 1px solid #cad4cf; border-radius: 8px; background: #fff; color: #25332c; font: 12px/1.45 system-ui, sans-serif; }
          .classify select { flex: 1; min-width: 170px; padding: 8px; border: 1px solid #cad4cf; border-radius: 8px; background: #fff; color: #25332c; }
          .supported { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin: 0 0 18px; padding: 10px 12px; border-radius: 9px; background: #f2f6f4; }
          .supported-label { margin-right: 3px; color: #697870; font-size: 11px; }
          .platform { display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; border: 1px solid #d6dfda; border-radius: 999px; background: #fff; color: #28362f; font: 600 11px/1 system-ui, sans-serif; text-decoration: none; }
          .platform:hover { border-color: #8ca399; }
          .platform-icon { display: block; width: 18px; height: 18px; flex: 0 0 18px; object-fit: contain; }
          .findings { display: grid; gap: 7px; padding: 12px 14px 14px; }
          .finding { display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; align-items: center; padding: 10px 12px; border: 1px solid #dce3df; border-radius: 9px; }
          .finding label { display: flex; align-items: center; gap: 9px; min-width: 0; font-size: 13px; }
          .value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .type { color: #65746c; font-size: 10px; }
          .weak-note { color: #8a6a1c; }
          button { padding: 10px 14px; border-radius: 9px; border: 1px solid #cad4cf; font: 600 13px/1 system-ui, sans-serif; cursor: pointer; }
          .not-pii { padding: 7px 9px; background: #fff; color: #526159; font-size: 11px; }
          .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; column-gap: 12px; row-gap: 10px; margin-top: 16px; }
          .cancel, .original, .pause-protection { background: #fff; color: #25332c; }
          .pause-protection { margin-right: auto; }
          .redacted { border-color: #16794b; background: #16794b; color: #fff; }
          button:disabled { opacity: .5; cursor: not-allowed; }
          button:focus-visible, input:focus-visible { outline: 3px solid #78aaf8; outline-offset: 2px; }
        </style>
        <div class="backdrop" role="presentation">
          <section class="modal" role="alertdialog" aria-modal="true" aria-labelledby="privy-title" aria-describedby="privy-description">
            <nav class="supported" aria-label="Supported AI chat sites">
              <span class="supported-label">Protected on</span>
              <a class="platform" href="https://chatgpt.com/" target="_blank" rel="noreferrer"><img class="platform-icon" src="${chrome.runtime.getURL("platform-icons/chatgpt.svg")}" alt="">ChatGPT</a>
              <a class="platform" href="https://claude.ai/" target="_blank" rel="noreferrer"><img class="platform-icon" src="${chrome.runtime.getURL("platform-icons/claude.svg")}" alt="">Claude</a>
              <a class="platform" href="https://gemini.google.com/" target="_blank" rel="noreferrer"><img class="platform-icon" src="${chrome.runtime.getURL("platform-icons/gemini.svg")}" alt="">Gemini</a>
            </nav>
            <h2 id="privy-title">Private information detected</h2>
            <p id="privy-description" class="lead">Choose which detected values to replace with placeholders, send the original message, or cancel.</p>
            <p class="message-label">Original message</p>
            <div class="message" aria-label="Message with private information highlighted"></div>
            <p class="hint">Red highlights will be replaced. Yellow highlights will remain unchanged.</p>
            <p class="message-label">Redacted message preview</p>
            <div class="message redacted-preview" aria-label="Redacted message preview" aria-live="polite"></div>
            <p class="hint restore-hint">This is the exact message that “Send redacted” will send.</p>
            <details class="detected-details">
              <summary>Detected PII <span class="summary-meta detected-count"></span></summary>
              <div class="findings"></div>
            </details>
            <details class="missing-details">
              <summary>Missing PII not redacted?</summary>
              <div class="classify">
                <span>Select missed private text in this box:</span>
                <textarea class="selection-input" readonly aria-label="Select text to classify"></textarea>
                <span class="selection-status">No text selected.</span>
                <select class="classification" aria-label="Private information category">
                  <option value="PERSON">Person</option>
                  <option value="ORGANIZATION">Organization</option>
                  <option value="LOCATION">Location</option>
                  <option value="EMAIL">Email</option>
                  <option value="PHONE">Phone</option>
                  <option value="DATE_OF_BIRTH">Date of birth</option>
                  <option value="PRIVATE_ENTITY">Other private information</option>
                </select>
                <button class="add-private" type="button" disabled>Classify & redact</button>
              </div>
            </details>
            <div class="actions">
              <button class="pause-protection" type="button">Pause protection</button>
              <button class="cancel" type="button">Cancel</button>
              <button class="original" type="button">Send original</button>
              <button class="redacted" type="button">Send redacted</button>
            </div>
          </section>
        </div>`;

      const messageBox = shadow.querySelector(".message");
      const redactedPreview = shadow.querySelector(".redacted-preview");
      const findingsBox = shadow.querySelector(".findings");
      const redactedButton = shadow.querySelector(".redacted");
      const cancelButton = shadow.querySelector(".cancel");
      const originalButton = shadow.querySelector(".original");
      const pauseButton = shadow.querySelector(".pause-protection");
      const backdrop = shadow.querySelector(".backdrop");
      const classification = shadow.querySelector(".classification");
      const addPrivateButton = shadow.querySelector(".add-private");
      const selectionStatus = shadow.querySelector(".selection-status");
      const selectionInput = shadow.querySelector(".selection-input");
      const detectedCount = shadow.querySelector(".detected-count");
      let pendingSelection = null;
      let pointerSelectionStart = null;
      const restoreHint = shadow.querySelector(".restore-hint");
      selectionInput.value = message;
      if (restoreResponses) {
        restoreHint.textContent = "This is the exact message that “Send redacted” will send. Placeholders in the reply are swapped back to the original values on this device only.";
      }
      pauseButton.textContent = extensionPaused ? "Resume protection" : "Pause protection";

      if (!messageBox || !redactedPreview || !findingsBox || !redactedButton || !cancelButton || !originalButton || !backdrop) {
        host.remove();
        resolve({ action: "cancel", error: "PRIVY_MODAL_INITIALIZATION_FAILED" });
        return;
      }

      function render() {
        appendHighlightedMessage(messageBox, message, findings, selected, active);
        const previewVault = pseudo.cloneVault(vault);
        redactedPreview.textContent = redactedMessage(message, findings, selected, previewVault);
        findingsBox.replaceChildren();
        for (const index of active) {
          const finding = findings[index];
          const row = document.createElement("div");
          row.className = "finding";
          const label = document.createElement("label");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = selected.has(index);
          checkbox.addEventListener("change", () => {
            checkbox.checked ? selected.add(index) : selected.delete(index);
            render();
          });
          const description = document.createElement("span");
          const value = document.createElement("span");
          value.className = "value";
          value.textContent = finding.value;
          const type = document.createElement("span");
          type.className = "type";
          type.textContent = selected.has(index)
            ? `${finding.type} → ${pseudo.tokenFor(previewVault, finding.type, finding.value, instructions.placeholders)}`
            : `${finding.type} → kept as written`;
          description.append(value, document.createElement("br"), type);
          if (finding.weak) {
            const note = document.createElement("span");
            note.className = "type weak-note";
            note.textContent = " · no personal context detected";
            description.append(note);
          }
          label.append(checkbox, description);
          const notPii = document.createElement("button");
          notPii.type = "button";
          notPii.className = "not-pii";
          notPii.textContent = "Not PII";
          notPii.title = "Remember this false positive only on this device";
          notPii.addEventListener("click", async () => {
            notPii.disabled = true;
            notPii.textContent = "Saving locally…";
            const targetStart = Number.isInteger(finding.start) ? finding.start : null;
            const targetEnd = Number.isInteger(finding.end) ? finding.end : null;
            const targetValue = String(finding.value || "").trim().toLocaleLowerCase();
            const related = [...active].filter((candidateIndex) => {
              const candidate = findings[candidateIndex];
              if (targetStart !== null && targetEnd !== null && Number.isInteger(candidate.start) && Number.isInteger(candidate.end)) {
                return candidate.start < targetEnd && candidate.end > targetStart;
              }
              return String(candidate.value || "").trim().toLocaleLowerCase() === targetValue;
            });
            for (const candidateIndex of related) {
              await rememberNotPrivate(findings[candidateIndex]);
              active.delete(candidateIndex);
              selected.delete(candidateIndex);
            }
            render();
          });
          row.append(label, notPii);
          findingsBox.append(row);
        }
        if (!active.size) findingsBox.append(document.createTextNode("All findings were marked as not PII."));
        detectedCount.textContent = `${active.size} finding${active.size === 1 ? "" : "s"}`;
        redactedButton.disabled = selected.size === 0;
      }

      function messageOffset(container, offset) {
        const before = document.createRange();
        before.selectNodeContents(messageBox);
        try {
          before.setEnd(container, offset);
        } catch {
          return null;
        }
        return before.toString().length;
      }

      function setPendingSelection(rawStart, rawEnd) {
        let start = Math.min(rawStart, rawEnd);
        let end = Math.max(rawStart, rawEnd);
        while (start < end && /\s/.test(message[start])) start += 1;
        while (end > start && /\s/.test(message[end - 1])) end -= 1;
        if (end <= start || end - start > 200) {
          pendingSelection = null;
          addPrivateButton.disabled = true;
          selectionStatus.textContent = end - start > 200
            ? "Choose 200 characters or fewer."
            : "Highlight text in the original message to add it as private information.";
          return;
        }
        pendingSelection = { start, end, value: message.slice(start, end) };
        addPrivateButton.disabled = false;
        selectionStatus.textContent = `Selected: “${pendingSelection.value}”`;
      }

      function caretOffsetAtPoint(x, y) {
        const caret = document.caretRangeFromPoint?.(x, y);
        if (!caret || !messageBox.contains(caret.startContainer)) return null;
        return messageOffset(caret.startContainer, caret.startOffset);
      }

      function captureSelection() {
        const selection = window.getSelection();
        if (!selection?.rangeCount || selection.isCollapsed) return;
        const selectedRange = selection.getRangeAt(0);
        if (!messageBox.contains(selectedRange.startContainer) || !messageBox.contains(selectedRange.endContainer)) return;
        const start = messageOffset(selectedRange.startContainer, selectedRange.startOffset);
        const end = messageOffset(selectedRange.endContainer, selectedRange.endOffset);
        if (start !== null && end !== null) setPendingSelection(start, end);
      }

      messageBox.addEventListener("pointerdown", (event) => {
        pointerSelectionStart = caretOffsetAtPoint(event.clientX, event.clientY);
      });
      messageBox.addEventListener("pointerup", (event) => {
        const end = caretOffsetAtPoint(event.clientX, event.clientY);
        if (pointerSelectionStart !== null && end !== null) {
          setPendingSelection(pointerSelectionStart, end);
        }
        pointerSelectionStart = null;
      });
      messageBox.addEventListener("mouseup", captureSelection);
      messageBox.addEventListener("keyup", captureSelection);
      const captureInputSelection = () => {
        if (selectionInput.selectionEnd <= selectionInput.selectionStart) {
          pendingSelection = null;
          addPrivateButton.disabled = true;
          selectionStatus.textContent = "No text selected.";
          return;
        }
        setPendingSelection(selectionInput.selectionStart, selectionInput.selectionEnd);
      };
      selectionInput.addEventListener("select", captureInputSelection);
      selectionInput.addEventListener("mouseup", captureInputSelection);
      selectionInput.addEventListener("keyup", captureInputSelection);
      addPrivateButton.addEventListener("click", async () => {
        if (!pendingSelection) return;
        addPrivateButton.disabled = true;
        addPrivateButton.textContent = "Learning locally…";
        const finding = {
          ...pendingSelection,
          type: classification.value,
          source: "local-user-classification",
          score: 1,
        };
        await rememberPrivate(finding.value, finding.type);
        findings.push(finding);
        const index = findings.length - 1;
        active.add(index);
        selected.add(index);
        pendingSelection = null;
        window.getSelection()?.removeAllRanges();
        addPrivateButton.textContent = "Classify & redact";
        selectionStatus.textContent = "Saved locally. It will be recognized in future messages.";
        render();
      });

      const finish = (choice) => {
        document.removeEventListener("keydown", onKeyDown, true);
        host.remove();
        resolve(choice);
      };
      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish({ action: "cancel" });
        }
      };
      cancelButton.addEventListener("click", () => finish({ action: "cancel" }));
      pauseButton.addEventListener("click", async () => {
        pauseButton.disabled = true;
        extensionPaused = !extensionPaused;
        await chrome.storage.local.set({ extensionPaused });
        pauseButton.textContent = extensionPaused ? "Resume protection" : "Pause protection";
        pauseButton.disabled = false;
      });
      originalButton.addEventListener("click", () => finish({ action: "original", message }));
      redactedButton.addEventListener("click", () => {
        const sendVault = pseudo.cloneVault(vault);
        finish({
          action: "redacted",
          message: redactedMessage(message, findings, selected, sendVault),
          vault: sendVault,
        });
      });
      backdrop.addEventListener("click", (event) => {
        if (event.target.classList.contains("backdrop")) finish({ action: "cancel" });
      });
      document.addEventListener("keydown", onKeyDown, true);
      document.documentElement.append(host);
      render();
      cancelButton.focus();
    });
  }

  function replaceComposerMessage(composer, message) {
    if (!composer) throw new Error(`${siteAdapter.name} message composer is unavailable`);
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(composer, message);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertText", false, message);
    if (!inserted) {
      composer.replaceChildren(document.createTextNode(message));
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: message,
      }));
    }
  }

  async function readyComposer(fallback) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const composer = findComposer();
      if (composer?.isConnected) return composer;
      if (fallback?.isConnected) return fallback;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${siteAdapter.name} message composer did not become ready after redaction`);
  }

  async function readySendButton(fallback) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const button = findSendButton() || fallback;
      if (button && !button.disabled) return button;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${siteAdapter.name} send button did not become ready after redaction`);
  }

  function showScanFailureModal(errorMessage) {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .backdrop { position:fixed; inset:0; z-index:2147483647; display:grid; place-items:center; padding:20px; background:rgba(0,0,0,.68); font-family:Inter,system-ui,sans-serif; color:#17201c; }
        .dialog { width:min(480px,calc(100vw - 40px)); box-sizing:border-box; padding:22px; border-radius:14px; background:#fff; box-shadow:0 24px 80px rgba(0,0,0,.35); }
        h2 { margin:0 0 8px; font-size:19px; } p { margin:0 0 16px; color:#526159; font-size:13px; line-height:1.5; }
        details { margin:14px 0; color:#697870; font-size:11px; } summary { cursor:pointer; user-select:none; }
        pre { max-height:150px; overflow:auto; padding:9px; border-radius:7px; background:#f2f5f3; color:#3b4942; white-space:pre-wrap; overflow-wrap:anywhere; }
        .log-link { padding:0; border:0; background:transparent; color:#16794b; font:600 11px system-ui,sans-serif; cursor:pointer; text-decoration:underline; }
        .actions { display:flex; justify-content:flex-end; } .close { padding:9px 14px; border:0; border-radius:8px; background:#16794b; color:#fff; font:600 13px system-ui,sans-serif; cursor:pointer; }
      </style>
      <div class="backdrop">
        <section class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="scan-error-title">
          <h2 id="scan-error-title">Local privacy scan failed</h2>
          <p>The message was not sent. You can review local diagnostics if you want to investigate the model error.</p>
          <details>
            <summary>Technical details</summary>
            <pre></pre>
            <button class="log-link" type="button">View local diagnostic logs</button>
          </details>
          <div class="actions"><button class="close" type="button">Close</button></div>
        </section>
      </div>`;
    shadow.querySelector("pre").textContent = errorMessage;
    const close = () => host.remove();
    shadow.querySelector(".close").addEventListener("click", close);
    shadow.querySelector(".backdrop").addEventListener("click", (event) => {
      if (event.target.classList.contains("backdrop")) close();
    });
    shadow.querySelector(".log-link").addEventListener("click", () => {
      sendRuntimeMessageSafely({ type: "open-logs" });
    });
    document.documentElement.append(host);
    shadow.querySelector(".close").focus();
  }

  function sendRuntimeMessageSafely(message) {
    try {
      const pending = chrome.runtime.sendMessage(message);
      if (pending?.catch) pending.catch(() => {});
    } catch {
      // An open chat tab can temporarily retain this script after the extension
      // is reloaded. Diagnostics must not create a second uncaught exception.
    }
  }

  // --- Reversible placeholder mapping -------------------------------------

  function currentConversationId() {
    return pseudo.conversationId(location.hostname, location.pathname);
  }

  function vaultKey(conversation) {
    return `${location.hostname}/${conversation || "draft"}`;
  }

  function vaultFor(conversation) {
    return pseudo.createVault(vaults[vaultKey(conversation)]?.entries);
  }

  function pruneVaults(all) {
    const cutoff = Date.now() - VAULT_TTL_MS;
    return Object.fromEntries(
      Object.entries(all)
        .filter(([, stored]) => stored?.updatedAt > cutoff)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, MAX_VAULTS)
    );
  }

  async function saveVault(conversation, vault, removeKey = null) {
    const stored = await chrome.storage.local.get(VAULT_STORAGE_KEY);
    const all = stored[VAULT_STORAGE_KEY] || {};
    all[vaultKey(conversation)] = { updatedAt: Date.now(), entries: vault.entries };
    if (removeKey) delete all[removeKey];
    vaults = pruneVaults(all);
    await chrome.storage.local.set({ [VAULT_STORAGE_KEY]: vaults });
  }

  let lastConversationId = currentConversationId();

  async function followConversationChanges() {
    const conversation = currentConversationId();
    if (conversation === lastConversationId) return;
    lastConversationId = conversation;
    const draft = vaults[vaultKey(null)];
    if (conversation && draft && Date.now() - draft.updatedAt < DRAFT_ADOPTION_WINDOW_MS) {
      const adopted = vaultFor(conversation);
      for (const [key, entry] of Object.entries(draft.entries)) adopted.entries[key] ??= entry;
      await saveVault(conversation, adopted, vaultKey(null));
    }
    scheduleFullRestore();
  }

  setInterval(() => { void followConversationChanges().catch(() => {}); }, 1000);

  // Tokens in rendered text are swapped back in place. Only text node values
  // change (no wrapper elements), so the chat app's own rendering is not
  // disturbed; the CSS Custom Highlight API marks restored values.
  const restoredHighlight = typeof Highlight === "function" && globalThis.CSS?.highlights
    ? new Highlight()
    : null;
  if (restoredHighlight) CSS.highlights.set("privy-restored", restoredHighlight);
  const pendingRestoreNodes = new Set();
  let restoreScheduled = false;
  const TOKEN_HINT = /[A-Z]_\d/;
  // The user's own sent messages keep their placeholders, so the chat itself
  // shows what the provider actually received. Only AI replies are restored.
  const USER_MESSAGE_SELECTOR = (siteAdapter.userMessageSelectors || []).join(", ");

  function vaultForNode(node) {
    const href = node.parentElement?.closest("a[href]")?.getAttribute("href");
    if (href) {
      try {
        const linked = pseudo.conversationId(location.hostname, new URL(href, location.href).pathname);
        if (linked) return vaults[vaultKey(linked)];
      } catch {
        // Ignore malformed links.
      }
    }
    return vaults[vaultKey(currentConversationId())];
  }

  function restoreTextNode(node) {
    if (!TOKEN_HINT.test(node.nodeValue)) return;
    const parent = node.parentElement;
    // Never touch editable text: restored values must not be sent back out.
    if (!parent || parent.isContentEditable || parent.closest("textarea, input, script, style, noscript")) return;
    if (USER_MESSAGE_SELECTOR && parent.closest(USER_MESSAGE_SELECTOR)) return;
    const vault = vaultForNode(node);
    if (!vault) return;
    const { text, restored } = pseudo.restore(node.nodeValue, vault);
    if (!restored.length) return;
    node.nodeValue = text;
    if (!restoredHighlight) return;
    for (const { start, end } of restored) {
      const range = new Range();
      range.setStart(node, start);
      range.setEnd(node, end);
      restoredHighlight.add(range);
    }
  }

  function flushRestore() {
    restoreScheduled = false;
    const roots = [...pendingRestoreNodes];
    pendingRestoreNodes.clear();
    if (!restoreResponses) return;
    for (const root of roots) {
      if (!root.isConnected) continue;
      if (root.nodeType === Node.TEXT_NODE) {
        restoreTextNode(root);
        continue;
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) restoreTextNode(walker.currentNode);
    }
    if (restoredHighlight) {
      for (const range of restoredHighlight) {
        if (range.collapsed || !range.startContainer.isConnected) restoredHighlight.delete(range);
      }
    }
  }

  function scheduleRestore(node) {
    pendingRestoreNodes.add(node);
    if (restoreScheduled) return;
    restoreScheduled = true;
    // rAF does not fire in background tabs; the timer keeps streaming replies current.
    setTimeout(flushRestore, 50);
  }

  function scheduleFullRestore() {
    if (document.body) scheduleRestore(document.body);
  }

  const restoreObserver = new MutationObserver((mutations) => {
    if (!restoreResponses || !Object.keys(vaults).length) return;
    for (const mutation of mutations) {
      if (mutation.type === "characterData") scheduleRestore(mutation.target);
      else mutation.addedNodes.forEach(scheduleRestore);
    }
  });

  function startRestoring() {
    restoreObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleFullRestore();
  }

  if (document.body) startRestoring();
  else document.addEventListener("DOMContentLoaded", startRestoring, { once: true });

  async function approveAndSend(message, sendButton, originalComposer) {
    if (scanInProgress) return;
    scanInProgress = true;

    try {
      const conversation = currentConversationId();
      const vault = restoreResponses ? vaultFor(conversation) : pseudo.createVault();
      const result = await scanMessage(message, vault);
      let outgoingMessage = message;
      if (result.hasPrivateInfo) {
        const choice = await showPrivacyModal(message, result, vault);
        if (choice.action === "cancel") {
          if (choice.error) window.alert(`The privacy confirmation could not open (${choice.error}). The message was not sent.`);
          return;
        }
        outgoingMessage = choice.message;
        // Saved before sending so the streamed reply can be restored immediately.
        if (choice.vault && restoreResponses) await saveVault(conversation, choice.vault);
      }

      if (outgoingMessage !== message) {
        const activeComposer = await readyComposer(originalComposer);
        replaceComposerMessage(activeComposer, outgoingMessage);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      const activeSendButton = await readySendButton(sendButton);
      bypassNextSend = true;
      activeSendButton.click();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error || "Unknown local scan error");
      const needsDownload = errorMessage.includes("MODEL_NOT_READY");
      const staleExtension = /Extension context invalidated|Receiving end does not exist|Could not establish connection/i.test(errorMessage);
      if (needsDownload) {
        window.alert("The selected privacy model has not been downloaded. The message was not sent.\n\nOpen the Privacy Guard extension and click Download selected model.");
      } else if (staleExtension) {
        window.alert("Privacy Guard was reloaded or updated. The message was not sent.\n\nRefresh this chat page once, then try again.");
      } else {
        sendRuntimeMessageSafely({
          target: "background",
          type: "log-event",
          entry: { level: "error", event: "content-scan-request-failed", detail: errorMessage },
        });
        showScanFailureModal(errorMessage);
      }
      console.info(`Privy Local Privacy Guard: ${errorMessage}`);
    } finally {
      scanInProgress = false;
    }
  }

  document.addEventListener("click", (event) => {
    const sendButton = findSendButton(event.target);
    if (!sendButton || sendButton.disabled) return;
    if (bypassNextSend) {
      bypassNextSend = false;
      return;
    }
    if (!privacyConsentAccepted || extensionPaused) return;
    const composer = findComposer();
    const message = readMessage(composer);
    if (!message) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void approveAndSend(message, sendButton, composer);
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!privacyConsentAccepted || extensionPaused) return;
    const composer = findComposer();
    if (!composer || !composer.contains(event.target)) return;
    const isSendShortcut =
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.isComposing;
    if (!isSendShortcut) return;
    const message = readMessage(composer);
    const sendButton = findSendButton();
    if (!message || !sendButton || sendButton.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void approveAndSend(message, sendButton, composer);
  }, true);
})();
