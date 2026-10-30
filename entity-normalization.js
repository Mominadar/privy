export function normalizeEntity(item, modelId, text) {
  const start = Number.isInteger(item.start) ? item.start : null;
  const end = Number.isInteger(item.end) ? item.end : null;
  const offsetValue = start !== null && end !== null
    ? text.slice(start, end)
    : "";

  const rawType = String(item.entity_group || item.entity || "PRIVATE_ENTITY")
      .replace(/^B-|^I-/, "")
      .toUpperCase();
  const typeAliases = {
    PRIVATE_PERSON: "PERSON",
    PRIVATE_EMAIL: "EMAIL",
    PRIVATE_PHONE: "PHONE",
    PRIVATE_DATE: "DATE_OF_BIRTH",
  };

  return {
    type: typeAliases[rawType] || rawType,
    value: offsetValue || String(item.word || "").replace(/\s*##/g, "").trim(),
    source: modelId,
    score: Number(item.score || 0),
    start,
    end,
  };
}

export function mergeAdjacentEntities(entities, text) {
  const sorted = [...entities].sort((a, b) => {
    if (a.start === null) return 1;
    if (b.start === null) return -1;
    return a.start - b.start || a.end - b.end;
  });
  const merged = [];

  for (const entity of sorted) {
    const previous = merged.at(-1);
    const hasOffsets = Boolean(
      previous &&
      Number.isInteger(previous.start) &&
      Number.isInteger(previous.end) &&
      Number.isInteger(entity.start) &&
      Number.isInteger(entity.end)
    );
    const gap = hasOffsets ? text.slice(previous.end, entity.start) : null;
    const canMerge =
      hasOffsets &&
      previous.source === entity.source &&
      previous.type === entity.type &&
      entity.start >= previous.end &&
      entity.start - previous.end <= 3 &&
      /^[\s-]*$/.test(gap);

    if (!canMerge) {
      merged.push({ ...entity });
      continue;
    }

    const previousLength = previous.end - previous.start;
    const entityLength = entity.end - entity.start;
    previous.end = entity.end;
    previous.value = text.slice(previous.start, previous.end);
    previous.score =
      ((previous.score * previousLength) + (entity.score * entityLength)) /
      (previousLength + entityLength);
  }

  return merged;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWholeWord(text, start, end) {
  return !WORD_CHAR.test(text[start - 1] || "") && !WORD_CHAR.test(text[end] || "");
}

function wordEnd(text, index) {
  while (index < text.length && WORD_CHAR.test(text[index])) index += 1;
  return index;
}

const escapeChar = (ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Transformers.js token classification returns decoded words without
 * character offsets. Entities arrive in reading order, so each one is located
 * by searching forward from the previous match, tolerating the whitespace the
 * tokenizer inserts or removes. Whole-word matches are preferred so that a
 * fragment is never pinned to the inside of an unrelated word.
 *
 * "simple" aggregation drops subwords the model labelled "O", even mid-entity
 * ("Luc Fernández" for "Lucía Fernández"), so word characters may be skipped
 * between the words of an entity.
 */
export function alignEntities(entities, text) {
  let cursor = 0;
  return entities.map((entity) => {
    if (Number.isInteger(entity.start) && Number.isInteger(entity.end)) return entity;
    const words = String(entity.value || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return entity;
    const wordPatterns = words.map((word) => [...word].map(escapeChar).join("\\s*"));
    const bodies = [wordPatterns.join("\\s*"), wordPatterns.join("[\\p{L}\\p{M}\\p{N}]*\\s*")];
    for (const flags of ["gu", "giu"]) {
      let first = null;
      for (const body of bodies) {
        const pattern = new RegExp(body, flags);
        pattern.lastIndex = cursor;
        let match;
        while ((match = pattern.exec(text))) {
          const candidate = { start: match.index, end: match.index + match[0].length };
          if (isWholeWord(text, candidate.start, candidate.end)) {
            cursor = candidate.end;
            return { ...entity, ...candidate, value: text.slice(candidate.start, candidate.end) };
          }
          first ||= candidate;
        }
      }
      if (first) {
        cursor = first.end;
        return { ...entity, ...first, value: text.slice(first.start, first.end) };
      }
    }
    return entity;
  });
}

/**
 * The model often labels a word's trailing subwords "O" ("Mwang" + "##i").
 * Like the Python pipeline's word-level aggregation, an entity that starts on
 * a word boundary is widened to the end of its last word. Run after merging so
 * split pieces ("Aye" + "sha Khan") are joined first. Fragments that start
 * inside a word are left alone for the fragment filter to reject.
 */
export function widenToWords(entities, text) {
  return entities.map((entity) => {
    if (!Number.isInteger(entity.start) || WORD_CHAR.test(text[entity.start - 1] || "")) return entity;
    const end = wordEnd(text, entity.end);
    return end === entity.end ? entity : { ...entity, end, value: text.slice(entity.start, end) };
  });
}

/**
 * Splits text into chunks the model can read without truncation (BERT models
 * stop at 512 tokens). Cuts prefer paragraph, sentence, then word boundaries.
 */
export function chunkText(text, maxChars = 800) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const window = text.slice(start, end);
      const cut = [/\n\s*\n(?![\s\S]*\n\s*\n)/, /[.!?]\s(?![\s\S]*[.!?]\s)/, /\s(?![\s\S]*\s)/]
        .map((regex) => window.search(regex))
        .find((index) => index > maxChars / 2);
      if (cut !== undefined) end = start + cut + 1;
    }
    chunks.push({ start, text: text.slice(start, end) });
    start = end;
  }
  return chunks;
}
