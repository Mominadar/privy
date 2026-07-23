import test from "node:test";

test.todo("Delete all local data removes privacyLogs as well as model files and adaptive feedback");
test.todo("Delete all local data remains available when no complete model is downloaded");
test.todo("Replacing a custom model removes the prior custom model's orphaned cached files");
test.todo("cached model readiness re-verifies content hashes rather than checking presence only");
test.todo("large model downloads do not retain both all chunks and a second full-size buffer");
test.todo("download progress updates are throttled to avoid one storage write per network chunk");
test.todo("download cancellation interrupts retry backoff immediately");
test.todo("learned private terms match token boundaries and do not redact substrings such as Ann in annual");
test.todo("IPv4 detection rejects octets above 255");
test.todo("payment-card detection validates candidate numbers before redaction");
test.todo("contextual name and organization rules support Unicode scripts and accented letters");
test.todo("a stalled model scan has a timeout and cannot block sending indefinitely");
test.todo("loaded inference pipelines dispose GPU and WASM resources during deletion");
