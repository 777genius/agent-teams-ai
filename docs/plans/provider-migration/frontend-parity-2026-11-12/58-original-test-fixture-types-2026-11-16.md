# Plan58 — restore the original test fixtures' TypeScript contracts

## Selected scope and original failure

This is a three-test-file correction within the existing default-off Stage1 continuation. PR1192 stays Draft on its original base. No production API, schema, source admission, native provider, workflow, compiler pin, dependency, timeout, action, assertion or acceptance oracle is selected for change. The original complete CI gates remain required; there is no extra RED-only cycle or local project execution.

The original Fast feedback job133563800223 in run43933487486, on source3be1fb3ec43d5682aa2ca77a6af62e6fa27b597b, failed the canonical full-workspace TypeScript chain with nine diagnostics in these three existing fixtures. Its complete retained log is66802 bytes, SHA256cc535d013bb1a25a55853c2b5198a13deafae47fd9648680b3b550a73c0b4ce6. Scoped Host compiler and Main-test successes do not substitute for this failed workspace compiler.

| Existing path | Exact preimage | Observed diagnostic |
| --- | --- | --- |
| `test/features/agent-backend/capturedWindowsSelection.test.ts` | `0f0f46cc362cc3e377a4922eebb08193f5bffd33` | The callable `realpathSync.native` does not itself carry the root function's required `.native` namespace member. |
| `test/features/agent-backend/capturedWindowsSourceHistory.test.ts` | `aadbde250814c9c74225be65154e2d77ca7104bd` | Five V1 fixture projections retain the schema's wider V2 generation type; the original coordination environment's inferred three explicit properties omit its preserved HOME/NODE_OPTIONS keys. |
| `test/renderer/hooks/useMentionDetection.test.ts` | `cb9eb07f2bbfe4d213e4ec39ceae54bb828399fd` | The existing two-target synthetic-event fixture is intentionally partial; a direct assertion to the complete React SyntheticEvent is rejected. |

## Exact bounded correction

1. In the existing `canonical` helper, type its `read` parameter as `typeof original.realpathSync.native`. Both original root and native callables satisfy that call contract. Do not alter its existing argument tuple, pathname translation, selected-value projection, call count, result, wrapper or any filesystem operation.
2. In SourceHistory, add one local assertion-function declaration for the fixture's original V1 generation. The generic input remains the same object; the assertion narrows it to its original type intersected with `{ nativeGeneration?: 'v1' }`. Reject an own or inherited `nativeGeneration` value other than `undefined` or `'v1'`. Call it once after the existing management seed parse and once after the member parse's two unchanged provider checks, before returning the member. This is an explicit fixture precondition, not a cast of a V2 profile into V1, a production-schema change, or a new property assignment. All current input literals omit that generation property, so their original values and object shapes stay exact. Use a named function declaration with an explicit assertion return type, avoiding an inferred assertion callback.
3. Annotate only the existing coordination `environment` local as `Record<string, string>`. Its existing builder and all arguments stay byte-identical; do not add/remove/normalize environment entries or change the HOME/NODE_OPTIONS assertions.
4. Make the existing `selectEvent()` assertion explicitly cross `unknown` before `SyntheticEvent<HTMLTextAreaElement>`, matching the already-established partial keyboard-event fixture in the same file. The two textarea references and every event call remain exact. The hook consumes these two target fields; this test seam deliberately does not construct or dispatch a new DOM event. Do not widen the hook signature, add `any`, suppress diagnostics, or fabricate unrelated React event behavior.

This selects one small helper and two calls plus three local type expressions. It does not select a new test suite, helper module, framework or broader cleanup. The SourceHistory nine existing cases and the complete Selection/Mention cases remain; all original negative cases, assertions, deferred input/caret/IME transitions, teardown, environment mutations, source association, prepare/resume checks and filesystem bytes must be preserved. Plan54's two conditional nativeCli generation literals remain unchanged.

## Source evidence and boundaries

The official immutable sources were read at209aab743e0da2a8bce68b708281ebcb826c2570. `CapturedWindowsRuntimeSources.ts` blob87b49dfe4641f8152bb314ae27befa10b27b2f11 deliberately restricts SelectedWindowsProcessProfile.nativeGeneration to optionalv1. Runtime profile schema7dcaecc2d76bf568347082b5f82f0d738e0bfaa1 permits OpenCode's optionalv2; management schemaccefb500c16a228e03b7a1e4a47e04897fbca4f1 permits optionalv1/v2. These production boundaries are correct and remain untouched. The fixture literals in question select original V1 by omitting nativeGeneration. Native process schema34daeaecc7fa6d9f809bb3c69e0b7acdcde7fd73 and all current source/custody behavior remain exact.

The complete original log, three official fixture bodies and four official reference bodies are retained with their Git blobs. This is a source-level diagnosis. No compiler, project import, test, provider, installer, native process, GUI or generated verifier has been executed locally, and no compiler PASS is claimed.

## Publication, independent review and acceptance

Publish this bounded R1 and its independent prospective review before creating the source afterimages. The source packet must bind all three exact preimages, full afterimages and an exact inverse that restores every original byte after removing only the selected helper/calls/type expressions. A separate actual-source R2 must inspect the full diff and relevant callers, preserve all existing test cases/actions/assertions, and verify that no production/workflow/dependency path changed.

Before each publication, re-read the shared continuation ref and preserve every incoming leaf and author commit. If these exact preimages changed, reconcile the actual change rather than overwriting another writer. Create a source-only child and immediately push it with the current expected-SHA lease; verify full readback and the exact three-path tree delta. Keep PR1192 Draft and its base unchanged. Preserve useful running CI; root alone observes original runs at the existing cadence.

The next resulting-source original CI must run the canonical TS Native7.0.2 workspace chain and all original applicable frontend/Main suites. No TS5.9 fallback, isolated replacement, relaxed assertion, skipped error, timeout increase, manual dispatch/rerun or transfer of an earlier scoped PASS is selected. A new real diagnostic or assertion failure requires its own bounded repair. Queueing, cancellation and skipped checks remain unqualified. This correction does not close native/P08/P09/vendor/release or the full end-to-end goal.
