/*
 * Turns raw token-classification output into the final findings list.
 *
 * Shared by the offscreen document (WASM runtime) and the model evaluation
 * suite (Node runtime) so both exercise exactly the same post-processing.
 */
import { alignEntities, mergeAdjacentEntities, normalizeEntity, widenToWords } from "./entity-normalization.js";
import { filterModelEntities, patternFindings, resolveFindings } from "./detection-rules.js";

/**
 * `chunks` comes from `chunkText(text)` and `outputs[i]` is the detector's
 * result for `chunks[i].text`. `isSingleToken(word)` exposes the model's
 * vocabulary to the contextual detectors.
 */
export function findingsFromModelOutputs({ text, chunks, outputs, modelId, policy, isSingleToken }) {
  const entities = widenToWords(mergeAdjacentEntities(
    chunks.flatMap((chunk, index) =>
      alignEntities(outputs[index].map((item) => normalizeEntity(item, modelId, chunk.text)), chunk.text)
        .map((entity) => Number.isInteger(entity.start)
          ? { ...entity, start: entity.start + chunk.start, end: entity.end + chunk.start }
          : entity)
    ),
    text
  ), text);
  const patterns = patternFindings(text, { isSingleToken });
  const modelFindings = filterModelEntities(entities, text, policy, patterns)
    .sort((a, b) => Number(Boolean(a.weak)) - Number(Boolean(b.weak)) || b.score - a.score);
  return resolveFindings([...patterns, ...modelFindings])
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
}
