import assert from "node:assert/strict";
import test from "node:test";

import { CASES } from "./model-eval/cases.js";
import { EVAL_MODEL, grade, isDownloaded, loadScanner } from "./model-eval/detector.js";

const downloaded = await isDownloaded(EVAL_MODEL);
const skip = downloaded ? false : `${EVAL_MODEL} is not downloaded; run npm run models:download`;
const scan = downloaded ? await loadScanner(EVAL_MODEL) : null;

for (const testCase of CASES) {
  test(`[${EVAL_MODEL}] ${testCase.name}`, { skip }, async (t) => {
    const result = grade(testCase, await scan(testCase.text));
    for (const mismatch of result.typeMismatches) t.diagnostic(`type: ${mismatch}`);

    if (testCase.gap) {
      if (result.passed) t.diagnostic(`known gap now passes; remove the note: ${testCase.gap}`);
      else t.todo(`known gap: ${testCase.gap}`);
      return;
    }
    assert.deepEqual(
      { leaked: result.missed, overRedacted: result.falsePositives },
      { leaked: [], overRedacted: [] },
    );
  });
}
