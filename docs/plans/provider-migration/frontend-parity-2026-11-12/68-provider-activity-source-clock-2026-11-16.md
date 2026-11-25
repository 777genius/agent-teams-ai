# 68. Keep provider readiness display pure with the existing source clock

## Exact selection and current failure

Select the seven paths below on application `d4259ace0f265f5b2b060e485d291b8aaf426e9f`, tree `39e8ed2f35b657e3318a8c91e9e81c6ad9f0405e`, after the closed actual Plan65 source review. Keep the isolated branch `fix/frontend-parity-e2e-bounds-20261116`, all Plan63/64/65 changes and every unrelated leaf. Primary PR1192 remains Draft on its fixed base; preserve useful original executing jobs before its later update.

Original75 Team job `133621515563`, run `43959134362`, failed its full typed renderer lint at `ProviderActivityStatusStrip.tsx:168:59`: `react-hooks/purity` rejects the direct render-time `Date.now()` argument to captured readiness. The complete original workspace type chain and typed main lint completed; renderer lint had one error and1427 warnings. Its downstream GUI steps were skipped, so this is not a Team GUI result or TypeScript failure. Original raw2268881 bytes has SHA256 `89b1bb256c9bc46dc9258f715e7ecf82917b4c78c5937f87f309ad2f17667d67`; the exact first-boundary report11207 bytes has SHA256 `5599ef2d6484d140887aac523a438a7f3c61a2a511331074c948e3bf5930587c`.

The complete current Strip, existing clock owner, time-sensitive utilities, captured-readiness owner and current Strip tests were read. The independent source finding and its9183-byte addendum `e94f5a74058cb214423475a67607208d8252e769555f7804f6ee3cda3235cee0` establish a bounded reuse of the existing clock. The initial advisory five-path option is completed here with two existing validation files: three actual dependencies are absent from every current explicit Desktop roster and from the133 selected fast-lint operands. No source afterimage precedes actual documentary review.

| Selected path | Exact preimage | Bytes / physical lines | Scope |
| --- | --- | ---: | --- |
| `src/renderer/hooks/useEffectiveCliProviderStatus.ts` | `4a4c5150cc13bc59a914d34f29033890a2541697` | 9697 / 286 | Move only the existing conservative clock interface/function to the new React-only hook; import it. Preserve both original consumers and their expiry effects. |
| `src/renderer/hooks/useConservativeNow.ts` | Absent in actual `d425` | New, small | Own the literal existing source-bound layout clock. Export the same function, with only its existing React imports. |
| `src/renderer/components/common/ProviderActivityStatusStrip.tsx` | `c1d31ee945c28cfe1f1339d914d0d1be7fc5e928` | 13822 / 396 | Reuse that clock for the existing provider-state computation and its four time-sensitive call sites. |
| `src/renderer/utils/teamProviderRuntimeStatusLoading.ts` | `305aea0b97d3b2b59dd897e06e39cc2c82406ee9` | 4395 / 119 | Add only an optional fifth `now?: number` parameter to the loading predicate and forward it to its existing scoped-readiness call. |
| `test/renderer/components/common/ProviderActivityStatusStrip.test.ts` | `c1ab11f043ea5bcfb5325cb8fb6f147541076f38` | 28286 / 844 | Retain current display/authority assertions; cover stable-predicate expiry and explicit scoped-time boundaries with the existing fixtures. |
| `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts` | `86374c20f8597210a3331e9730a582df35105c92` | 22506 / 346 | Add exactly the three hook/loading dependency paths to the existing common list. Preserve Process and WindowsRetry arrays. |
| `.github/workflows/host-emulated-acceptance.yml` | `af1abdb8c2309b4122d50ba9bdfa745a896344de` | 141880 / 1768 | Add exactly those same three paths to the original fast-lint command:133 to136 unique operands. No other command/job/matrix/timeout change. |

## Reuse one existing clock responsibility

Move the complete existing `ConservativeClockSnapshot` interface and `useConservativeNow` implementation without changing its behavior. The new module imports only its existing React hooks; it is not a second implementation, timer, store, scheduler, provider abstraction or policy. The existing status module retains both calls, publication callbacks and catalog-expiry scheduling unchanged. The props-driven Strip imports the small shared clock directly, without acquiring the status module's Codex-account/store dependency.

No actual existing mock break or module cycle was proved, and neither is claimed as the reason for this extraction. The reason is sharing the already-existing React clock responsibility between two renderer owners. Do not rewrite unrelated mocks, module barrels or application wiring.

Keep the clock's exact source identity behavior: an unmatched source exposes positive infinity, then its existing layout effect publishes `Date.now()` for that exact source before paint. Preserve the reducer, `Object.is` comparison, callback dependencies and returned readonly tuple. Do not add an interval, expiry timer, mount-only frozen timestamp or render-time clock alias.

## Preserve the original recomputation boundary

Change the existing `providerStates` memo callback into a stable `readProviderStates(now: number)` callback with the same nine dependencies, once: `cliProviderStatusLoading`, `codexSnapshotPending`, `forcedLoadingProviderIdSet`, `hasCapturedTeamReadiness`, `openCodePreparationEvidence`, `providerIdSet`, `renderCliStatus?.providers`, `sourceProviderMap`, and `providerStatusOverride`. Use that callback identity as the source of `useConservativeNow`. The resulting provider-state memo invokes it with the published snapshot and depends on that callback and time.

Thus changed original inputs receive their own current snapshot; local clock publication and cycle-provider state changes do not create a new source or an update loop. A stable captured predicate combined with changed status/loading inputs cannot retain an old timestamp. Preserve the original provider filtering, loading/error precedence, global/scoped override rules, display cycles, text and tones.

Pass the same explicit snapshot to all four existing time-sensitive calls in that mapping: nested runtime-loading check, direct OpenCode scoped-readiness check, captured Team predicate, and effective provider launch authority. Positive infinity must remain conservative for catalog/captured proof checks; do not turn unknown time into readiness. Leave existing deliberate local-source behavior and all non-time readiness rules unchanged.

The runtime-loading utility receives `now?: number` and passes it unchanged to `hasSettledOpenCodeScopedPreparation`. Keep the latter's existing default `Date.now()` exactly where it is. An omitted fifth argument must preserve all old early returns and read the clock only in the same existing scoped branch. An eager default at the loading function entry would alter unrelated callers and is outside this selection.

`useCapturedTeamLaunchReadiness` (`e8f5137ea0b7b69f4c098203d797780be99a5c01`) remains unchanged: it already owns the original expiry timeout and recreates the predicate on owner rerender. The Launch dialog, its submission-time current clock, scope/selection proofs, expiry comparison, Host preparation/admission and action fences remain unchanged. This is a display computation fix, with no authorization or lease relaxation.

## Meaningful regressions in the existing suite

Keep all nine existing captured-readiness cases: draft, Team, preparation, selection, expiry, closed dialog, text-only evidence, failed proof and loading. Their current valid-proof and refusal assertions, unchanged global status, unrelated-provider errors and independent Launch guard remain meaningful.

Extend the existing table with expiry at the exact boundary while the captured predicate identity stays stable and another original provider-state dependency changes. Require the mounted Strip to stop showing Ready and the original Launch guard to refuse. This catches a mount-frozen or predicate-only time source. Use the same original fixture and component; no new renderer test framework or duplicated application state.

Reuse the existing scoped OpenCode fixture for a small explicit-time contract check: a supplied time just before catalog expiry can settle loading, equality and nonfinite time cannot. Temporarily make `Date.now()` throw during these direct explicit-time predicate checks, and restore it before actual React rendering, so the original ignored-fifth-argument behavior fails. Retain the original scoped Ready UI assertions afterward. The separate58-line utility test remains unchanged; do not create another suite or duplicate its fixture.

Preserve current normal provider display, status details, forced-loading and Codex bootstrap/error tests. The unchanged existing clock consumers and their suites still qualify the moved hook. These are source-selected regressions, not a claim that any new test has run.

## Complete the existing verification inputs

The three additions are exactly `src/renderer/hooks/useConservativeNow.ts`, `src/renderer/hooks/useEffectiveCliProviderStatus.ts`, and `src/renderer/utils/teamProviderRuntimeStatusLoading.ts`. Each is absent from the current four explicit Desktop source roster bodies and selected fast-lint list. Append them once to the existing common supplementary array and add each once to the existing command. Keep every old operand and roster entry in its existing order, including Plan63 additions; no discovery, generator, new workflow or qualification lane.

All production owners and the small shared hook must remain below800 ordinary physical lines, with natural formatting. The existing844-line test is a test suite, not a new production-limit exception; do not split or compress it to evade a limit. Preserve all unrelated source bytes, workflows and validation behavior.

## Publication and actual acceptance

Require prospective R1/R2, ordinary immediate-CAS documentary publication and complete actual documentary readback/R2 before source afterimages. Then require exact before/after review, strict forward/inverse patch, full source-tree union, scope/line/operand/roster checks and independent source R2. Publish the exact reviewed source with immediate ordinary CAS push and independently read back complete actual commit/tree/bodies and unrelated-leaf preservation.

Acceptance belongs to the original resulting-head workspace type chain, selected fast lint, full typed renderer lint, original frontend suite and affected Desktop journeys. Preserve their assertions and failure receipts; current75 lint failure and skipped Team GUI cannot be rewritten as PASS. No local project/import/install/compiler/lint/test/provider/native/GUI execution, manual Actions dispatch/rerun/cancel or commit solely to trigger CI is selected. No new PR, Ready promotion, merge, release, default activation or Stage2 follows. Native W01, P09 owner choices, genuine M16 and producer archive adoption retain their separate unresolved gates.
