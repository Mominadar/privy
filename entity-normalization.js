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
