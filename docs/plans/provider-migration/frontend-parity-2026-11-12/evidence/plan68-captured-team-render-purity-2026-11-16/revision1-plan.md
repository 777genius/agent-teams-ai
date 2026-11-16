# 68 — Captured Team readiness render purity

Status: prospective, awaiting root selection, publication and independent review. No source afterimage is authorized by this document alone. This continues the original Plan49 presentation contract after the concrete original 75cf typed-lint failure.

## 1. Evidence and preserved behavior

The retained original Team log is 2268881 bytes with SHA256 `89b1bb256c9bc46dc9258f715e7ecf82917b4c78c5937f87f309ad2f17667d67`. Full typed renderer lint reports `react-hooks/purity` at `ProviderActivityStatusStrip.tsx:168:59`, where `Date.now()` executes inside the render-time provider-state memo. This is the sole error in that result. Preserve the rule and all original validation commands.

Plan49's selected behavior remains: a fresh, exactly scoped captured Host Team proof can settle the selected provider's chip, while explicit loading, Codex bootstrap/snapshot masking, and scoped OpenCode readiness retain their existing precedence. A sibling without proof and every ordinary caller retain their original global fallback. Display evidence is not launch authority.

## 2. Exact two-path source inventory

| Existing path | Before Git blob | Before SHA256 | Bytes / lines |
| --- | --- | --- | --- |
| `src/renderer/components/common/ProviderActivityStatusStrip.tsx` | `c1d31ee945c28cfe1f1339d914d0d1be7fc5e928` | `b0f3a9ede1f0bb08f75f11c2742d0fdb14b281b1ea63da5509e50b38d9d98cac` | 13822 / 396 |
| `test/renderer/components/common/ProviderActivityStatusStrip.test.ts` | `c1ab11f043ea5bcfb5325cb8fb6f147541076f38` | `375ab28dfb1aaf9506b0c852fc97dc48ae612d38edf5fad3099dcf9e420de286` | 28286 / 844 |

The source bodies are exact official 75cf snapshots and match the original receipt source pins. Rebind their actual leaves to the immediate publication parent before editing or publishing; preserve all incoming source and documentation. The existing test/YAML exclusions and source-size baseline remain unchanged. The strip stays naturally below 800 lines; do not extract code or compress old cases to evade a size limit.

## 3. One local presentation snapshot

Inside the existing `useProviderActivityDisplay`, retain one nullable state value with exactly the optional captured-readiness predicate identity and an observation timestamp. Add a layout effect keyed by that predicate identity. When it exists, the effect captures `Date.now()` and stores the pair. When it is absent, clear that state to null without reading the clock. This is an actual commit-time observation; do not merely put `Date.now()` in a callback that is still called from render.

In the existing error expression, after the unchanged loading and scoped-OpenCode guards, use captured readiness only when the snapshot exists and its predicate is exactly the current prop. Invoke the original pure predicate with the stored timestamp. Add the snapshot to the existing memo dependencies, retain the predicate dependency, and preserve every other dependency and expression. A changed predicate must never borrow a ready result or observation time from the previous scope. Keep loading/scoped-readiness short-circuit behavior; do not eagerly call the predicate in branches that previously skipped it.

The layout effect settles before paint. It adds one bounded synchronization render per changed predicate; the child's state update does not recreate its parent prop, so there is no feedback loop. Keep the current timestamp for child-only rerenders with the same predicate. No timer, interval, new clock cadence, provider-ID whitelist, subscription framework, global store write or authority cache is added.

The sole existing caller in `LaunchTeamDialog.tsx` passes the fresh `capturedReadiness.permits`. The unchanged `useCapturedTeamLaunchReadiness.ts` expiry timer invalidates that parent and therefore supplies a new identity at expiry. Preserve that existing owner and exact expiry-plus-one scheduling, including its original clipping/cleanup. This selection relies on that established fresh-identity contract rather than claiming independent expiry updates for arbitrary stable callbacks. The optional prop remains absent for all other current callers.

Do not edit Launch, the readiness hook, the pure predicate, the fence, `createLaunchGuard`, `captureForSubmit`, Host admission, auth, persistence or selection. The latter guards retain their independent actual-time checks for every action. Do not use the thirty-second relative-time clock, widen expiry, retain stale authority, remove captured proof, or suppress lint.

## 4. Existing meaningful regressions

Retain every original test body and original API/logo mock. In particular retain the nine real-predicate/real-guard cases for draft, Team, preparation, selection, expiry, close, text-only, failed-check and loading changes, the sibling chip assertion, and global-object/guard preservation.

Append one real-owner regression in the same suite using `useCapturedTeamLaunchReadiness`, `hasCapturedTeamLaunchReadiness`, the existing `createProviderSubmissionFence()` and original guard. A finite read-only store-selector fixture may provide the hook's already-required source context; it must not replace the readiness hook, pure predicate, timer or guard. No preflight/provider/API operation is needed. Seed a proof matching the actual hook's draft signature, preparation and selected-model signature, with a known future expiry.

First establish the selected chip as ready. Advance fake time within validity and cause an unrelated child-only presentation rerender while preserving the parent predicate identity; prove readiness uses the same observation timestamp and remains correct, without creating a fresh clock tick. Then set actual fake time at expiry before processing its timer and prove the original action-time guard refuses. Process the real hook's existing expiry callback; without an artificial parent refresh, require the chip to leave Ready through the newly supplied predicate identity. Preserve original strict expiry, cleanup/unmount and real-timer restoration. The regression must exercise that real expiry owner, not a new test timer or manually manufactured expiry notification.

No existing assertion is relaxed, no extra native input is added, and no new framework/test file is selected. Source R2 must inspect the actual small harness and its scope. This prospective selection does not predict the execution outcome.

## 5. Closure, validation and publication

Both changed files are already original source-roster members and explicit fast-lint operands. Their directly used readiness hook, pure predicate, guard and fence are already pinned. No source-freeze or workflow change is selected. Keep full typed renderer lint, the original frontend tests/types and the original Installer/Team UI assertions and budgets.

After published selection, prepare only these two before/after images with complete hashes, a reversible patch, source R1 and independent actual-source R2. Verify every old test body and unchanged presentation/guard region. Root alone publishes with a fresh expected-parent update and full-tree preservation. No local project/provider/GUI/compiler/test execution, CI rerun/dispatch/cancel, real Claude/Codex command, Draft/base change, Ready or release action is part of this source preparation. The original failed 75cf result stays failed; the resulting-source checks remain mandatory.
