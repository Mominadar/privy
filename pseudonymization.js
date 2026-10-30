/*
 * Reversible, on-device pseudonymization.
 *
 * Each distinct private value in a conversation is replaced with a numbered
 * token such as [PERSON_1]. The token -> value map (the "vault") never leaves
 * this device. When the assistant's reply contains a token, it is swapped back
 * to the original value locally, so the AI provider only ever sees tokens.
 *
 * Loaded as a classic content script; it attaches to globalThis so that Node
 * tests can import it as a side-effect module.
 */
(() => {
  "use strict";

  const WORD_CHAR = /[\p{L}\p{N}_]/u;
  // Brackets are optional on restore because models occasionally drop them.
  const TOKEN_PATTERN = /\[?\b([A-Z][A-Z_]*?_\d{1,4})\b\]?/g;
  const TOKEN_HINT = /[A-Z]_\d/;

  function createVault(entries = {}) {
    return { entries: { ...entries } };
  }

  function cloneVault(vault) {
    return createVault(vault?.entries);
  }

  function normalizeValue(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  }

  /** "[PAYMENT_CARD]" -> "PAYMENT_CARD" so tokens match the placeholder names users already see. */
  function tokenLabel(type, placeholders) {
    const placeholder = placeholders[type] || placeholders.PRIVATE_ENTITY || "[PRIVATE_INFORMATION]";
    return placeholder.replace(/^\[|\]$/g, "").replace(/[^A-Z_]/g, "_") || "PRIVATE_INFORMATION";
  }

  function tokenFor(vault, type, value, placeholders) {
    const label = tokenLabel(type, placeholders);
    const normalized = normalizeValue(value);
    let highest = 0;
    for (const [key, entry] of Object.entries(vault.entries)) {
      const match = key.match(/^(.*)_(\d+)$/);
      if (!match || match[1] !== label) continue;
      if (normalizeValue(entry.value) === normalized) return `[${key}]`;
      highest = Math.max(highest, Number(match[2]));
    }
    const key = `${label}_${highest + 1}`;
    vault.entries[key] = { type, value: String(value).trim() };
    return `[${key}]`;
  }

  /**
   * Replaces non-overlapping, sorted ranges ({ start, end, type }) with tokens,
   * adding any new values to `vault` (mutated in place).
   */
  function pseudonymize(message, ranges, vault, placeholders) {
    let cursor = 0;
    let output = "";
    for (const range of ranges) {
      output += message.slice(cursor, range.start);
      output += tokenFor(vault, range.type, message.slice(range.start, range.end), placeholders);
      cursor = range.end;
    }
    return output + message.slice(cursor);
  }

  /**
   * Swaps tokens known to `vault` back to their values. Returns the restored
   * text and the restored value positions (offsets in the restored text).
   */
  function restore(text, vault) {
    const entries = vault?.entries;
    if (!entries || !TOKEN_HINT.test(text)) return { text, restored: [] };
    const restored = [];
    let delta = 0;
    const output = text.replace(TOKEN_PATTERN, (token, key, offset) => {
      const entry = entries[key];
      if (!entry) return token;
      const start = offset + delta;
      restored.push({ start, end: start + entry.value.length, key });
      delta += entry.value.length - token.length;
      return entry.value;
    });
    return { text: output, restored };
  }

  /** Whole-word, case-insensitive occurrences, so "Ann" never matches inside "annual". */
  function findWholeWord(text, value) {
    const needle = String(value || "").trim();
    if (!needle) return [];
    const haystack = text.toLocaleLowerCase();
    const lowerNeedle = needle.toLocaleLowerCase();
    const checkStart = WORD_CHAR.test(needle[0]);
    const checkEnd = WORD_CHAR.test(needle.at(-1));
    const positions = [];
    let index = 0;
    while ((index = haystack.indexOf(lowerNeedle, index)) !== -1) {
      const end = index + lowerNeedle.length;
      const startOk = !checkStart || !WORD_CHAR.test(text[index - 1] || "");
      const endOk = !checkEnd || !WORD_CHAR.test(text[end] || "");
      if (startOk && endOk) positions.push(index);
      index += Math.max(1, lowerNeedle.length);
    }
    return positions;
  }

  /** Values already tokenized in this conversation are always redacted again. */
  function vaultFindings(message, vault) {
    return Object.values(vault?.entries || {}).flatMap((entry) =>
      findWholeWord(message, entry.value).map((start) => ({
        type: entry.type,
        value: message.slice(start, start + entry.value.length),
        source: "conversation-mapping",
        score: 1,
        start,
        end: start + entry.value.length,
      }))
    );
  }

  /** Stable per-conversation key from a chat URL, or null for a new, unsaved chat. */
  function conversationId(hostname, pathname) {
    const patterns = {
      "chatgpt.com": /\/c\/([\w-]+)/,
      "chat.openai.com": /\/c\/([\w-]+)/,
      "claude.ai": /\/chat\/([\w-]+)/,
      "gemini.google.com": /\/app\/([\w-]+)/,
    };
    const match = pathname.match(patterns[hostname] || /$^/);
    return match ? match[1] : null;
  }

  globalThis.PrivyPseudonymization = Object.freeze({
    createVault,
    cloneVault,
    tokenFor,
    tokenLabel,
    pseudonymize,
    restore,
    findWholeWord,
    vaultFindings,
    conversationId,
  });
})();
