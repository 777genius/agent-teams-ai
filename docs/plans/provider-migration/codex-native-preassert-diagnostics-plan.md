# Codex native pre-assert diagnostics plan

Status: reviewed plan before implementation. This is a TEST-only evidence repair, not a qualification of native process ownership. The original two-root refusal remains required.

## Evidence and exact scope

The independently retained Codex Resume artifact `15268185810` (SHA-256 `9134e28e329e0a8dbe73e71b45cc5a7380affe7e9fc9654e5828ab78b4308e36`) records an original capture that rejected actual two matching Codex roots against expected one before retaining the witness. Existing startup and final cleanup tables did not establish the second root's original role. No role, ownership or native regression cause can be inferred from executable name or ancestry alone.

Exactly two existing TEST paths and one new pure TEST path are proposed:

1. `packages/legacy-agent-host/tests/fixtures/codex-native-closure.ts`
2. `scripts/legacy-agent-host/desktop-launch-ui-smoke.ts`
3. `packages/legacy-agent-host/tests/codex-native-closure.test.ts` (new)

Both existing paths were rechecked byte-for-byte at the target `73c7723c504327c8ba42cf656e7a39912af5e11e`, incoming Stage 1 `36df9dceba8b080e876952fdce619af447c797c0`, and the reviewed baseline. Their SHA-256 values are respectively `2703df268ef91a19abc81a3614a1c69f1a69e80c63b8ee867ecb603e13262a8c` and `b7ec8677a62afaf2f30dd18b68ee9b32e9b1eb6ee7d46656a05df7ff11ffe8e4`.

No production path, native pin, provider argument, runtime/session contract, process registration, deadline, retry, runner or workflow changes in this patch.

## One unchanged observation, saved before refusal

Add an optional synchronous diagnostic observer to `captureCodexCodeModeProcess`. Keep physical native pair, path and hash checks before the process read. Reuse the SAME one `read()` result already consumed by the helper. Before the current `roots.length === 1` assertion, project the selected Host PID, exact matching root/helper counts, and bounded matching candidate rows from that table.

The projection has `schemaVersion: 1` and `diagnosticOnly: true`. It contains at most 16 root rows and 32 helper rows, exact total counts and truncation flags, and at most 16 KiB of actual serialized UTF-8 bytes. Each row contains only positive safe PID/parent/group integers, the original birth string bounded to 64 UTF-8 bytes with ASCII control characters refused, and a fixed executable role (`codex` or `code-mode-host`). No raw argv, environment, prompt, header, arbitrary process object or unrelated OS row is emitted. The existing process reader already bounds the table to 2 MiB and 20,000 rows; joining helpers uses a temporary set of the already observed root PIDs.

Diagnostic objects contain copies, so an observer cannot mutate the original process table or witness. Projection, serialization and observer failures are caught locally; they cannot replace the original assertion, turn success into failure, or allow a failed capture to succeed. Truncation and helper relationships never choose a winning root.

The Desktop caller initializes its existing capture-attempted marker and installs the observer before awaiting capture. The observer saves only the bounded projection in that existing receipt, so the existing outer `finally` can persist evidence even when the count assertion throws. After success, `Object.assign` adds the diagnostic field to the SAME captured witness object; it must not copy the witness and lose later `afterStop` or first-identity-mismatch mutations. Failure retains capture-attempted/diagnostic-only state without a captured witness.

Keep the exact original root count, helper count, helper process group, birth, physical pin and post-Stop identity checks. There is no second receipt writer, process census, native RPC, asynchronous observation, process signal or cleanup owner. Ordinary Stop/Resume continues to refuse ambiguous roots.

## Finite baseline and candidate controls

Use TEST temporary files for both selected executable paths and real file hashes without executing them. Supply synthetic `ProcessFact` rows only through the helper's existing read callback and invoke the actual imported helper.

1. One root and one helper preserve the exact original witness, one process read and one bounded diagnostic.
2. Two matching roots preserve `AssertionError` actual 2 / expected 1 while retaining both candidates before rejection.
3. Zero roots preserve the original 0 / 1 refusal with exact diagnostic counts.
4. Foreign Host parents and different executable paths do not become matching roots.
5. Missing/duplicate helpers and the wrong helper process group preserve their original assertions.
6. Observer exceptions and attempted diagnostic mutations cannot alter the witness or negative assertion.
7. Candidate overflow preserves exact totals, truncation flags and the 16 KiB bound while the original root count still fails.
8. Physical path/hash mismatch occurs before read/diagnostic and preserves its refusal; existing post-Stop PID/birth/parent/group mismatch behavior remains covered.

The test's compatible function type copies the existing first three `Parameters` and `ReturnType`, adding only an OPTIONAL fourth observer accepting `unknown`. The old three-argument function satisfies this type without a cast or a new helper export. Baseline RED must be missing pre-assert evidence, not import/type failure or an expectation that ambiguous roots should pass. The physical-refusal control is expected to remain green.

The second source review corrected four test message expectations to anchored regular expressions matching the exact original prefix followed by newline/end. Node 24 appends assertion comparison details to `.message`; `actual`, `expected` and assertion code remain checked separately. This correction is required for meaningful baseline failure. No tests have been executed for this candidate at plan publication.

## Review and delivery gates

The provider audit supplied source/design review R1. Root reviewed the complete helper/caller/test changes, requested the assertion-message correction, and reviewed that exact R2 correction. Publish this plan through the normal commit hook before applying source changes.

After publication: run the eight pure controls against the unchanged helper and retain the exact failure log; apply the reviewed helper/caller changes; run the same controls, normal Host build and complete strict Host test graph, inherited Host-script strict typing, applicable formatting/lint and architecture/file-size guards. Preserve resource failures as unqualified gates. Only successful current-source checks qualify the patch. Normal ready-PR CI supplies physical platform/native qualification; this plan authorizes no manual rerun or deadline extension.

A later native observation may still fail to identify the second root's role. If so, investigate an independently reviewed original launch-bound observation. These diagnostics never become member-role authority or a basis for selecting or killing a process.
