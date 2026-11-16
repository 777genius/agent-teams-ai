# 61. Route the four original OpenCode V2 Desktop lifecycle journeys through existing CI

## Selection and exact source scope

This plan selects the four original V2 Desktop acceptance journeys that already exist in the general CI matrix: active/queued Quit with cold readback, pending-open Quit with cold readback, checkpoint Resume across a cold app/Host restart, and Composer PNG attachment with cold readback. Their original helpers and native assertions remain the authority. The change makes these finite OpenCode-only journeys reachable in the existing Draft-compatible Host Emulated workflow, alongside its already selected Review journey. It does not add product behavior or replace the original oracle.

The complete source scope is **one existing file**, `.github/workflows/host-emulated-acceptance.yml`. Its exact preimage is blob `4211a5b6de087018bdbf5a4ad41d488f16f61646`, SHA256 `e30db362721a07c03ca00ad5dbb4cb0da2297e92337089ad3fbfda1b4bbf180c`, 123074 bytes / 1562 physical lines. This is the published Plan60 version at [ac03d91bcd4d5678c653e09624978fffdc8f2784](https://github.com/777genius/agent-teams-ai/blob/ac03d91bcd4d5678c653e09624978fffdc8f2784/.github/workflows/host-emulated-acceptance.yml), retained unchanged by Plan59 source commit `fc100017fa5861611f5257527b1512b4c4ca5b46`. Preserve all 132 ordered fast-lint operands and all unrelated workflow bytes. The current common proof roster `desktop-proof-supplementary-sources.ts`, blob `a41bff15e351d829d9cbb0197a7026ad09d6dc18`, stays unchanged, including Plan60's existing test pin.

Root must verify this preimage at the actual publication parent, preserve all incoming work, and publish/read back this plan before source afterimages. No production, journey helper, test, source roster, general CI, input pin, provider policy or public API is selected for modification. Plan59's separate historical retained-runtime staging is unrelated and remains intact.

The source-bound R1 was rebound through 19 immutable official source reads at `209aab743e0da2a8bce68b708281ebcb826c2570`, including the landed Plan55 workflow and all eight original journey helpers. That record is SHA256 `a9739054471e875b9c4099c4b08d278b86da2922041c55f0e5450d5efede05e4`; the refined R1 proposal is SHA256 `12f8e4085844a53fa42eda13e275e05a2c89c29542e1534802564215c442a79a`. The current workflow has additionally been fetched at the immutable published Plan60 commit and matched to the preimage above. These are source findings, not runtime acceptance.

## Closed matrix and unchanged preparation

Add four explicit `macos-15` / `darwin-arm64` entries to the existing `offline-desktop-scenario` matrix. Keep the original 45-minute cap for each separate row and the unchanged 5-minute aggregate. Do not combine the journeys into one long row. Give only the existing Review row and these four entries two narrow static descriptors, `v2Mode` and `v2ReadbackMode`; the second is absent for Resume.

| Lane | Original warm mode (`v2Mode`) | Original cold mode (`v2ReadbackMode`) | Warm-only selector |
| --- | --- | --- | --- |
| Existing `opencode-v2-review` | `native-review-ui` | `native-review-readback-ui` | None. |
| `opencode-v2-quit-active` | `native-quit-ui` | `native-quit-readback-ui` | None; Quit scenario absent. |
| `opencode-v2-quit-pending-open` | `native-quit-ui` | `native-quit-readback-ui` | `LEGACY_DESKTOP_QUIT_SCENARIO=pending-open`. |
| `opencode-v2-resume` | `native-resume-ui` | Absent | `LEGACY_DESKTOP_RESUME_PROVIDER=opencode`. |
| `opencode-v2-chat-attachments` | `native-conversation-ui` | `native-readback-ui` | `LEGACY_DESKTOP_CHAT_ATTACHMENTS=1`. |

Use a closed lane-to-mode mapping and reject any unsupported combination; no receipt, log or external input chooses a mode or path. The four new rows correspond to the original general-CI variants `native-v2-quit-active-readback`, `native-v2-quit-pending-open-readback`, `native-v2-resume-ui` and `opencode-v2-chat-attachments`. Their general CI Ready/full-qualification gate remains unchanged.

Extend only the existing explicit finite lane predicates for V2 staging/preparation, the input receipt's native-provider label, hidden-artifact retention and exclusion from the generic emulated verifier. The resulting list is exactly the existing `opencode-v2-management` row plus these five native journey rows. Do not replace the list with a prefix wildcard. Management Settings/C8 steps and their validators remain byte-identical.

All selected warm and cold invocations retain `LEGACY_DESKTOP_OPENCODE_GENERATION=v2` and unset `LEGACY_DESKTOP_EMULATED_ONLY`. Keep the optional Quit/Resume/attachment selectors absent unless the exact warm row needs one. A small closed shell case can export that one warm-only selector; do not write it into GITHUB_ENV. Explicitly unset absent selectors before warm/cold invocation. In particular, an empty `LEGACY_DESKTOP_QUIT_SCENARIO` is invalid: the original backend accepts only undefined, or exactly `pending-open` on `native-quit-ui`. The pending selector must be absent during cold readback.

Reuse the existing captured Node/Host/pnpm/Corepack preparation and both existing V2 stage/prepare steps. The V2 fixture uses canonical `process.execPath`, so no additional native Node staging is needed. Preserve the original OpenCode 2.1.4 / Bun 1.4.4 byte/graph/custody checks and current runtime lock. Warm modes use the original finite localhost model; cold modes load the saved original fixture without creating a new model or Runtime actor. No genuine Claude/Codex executable, version/discovery command or provider account setup is introduced. Mixed-member, group-chat, captured-MCP, donor, checkpoint-upgrade, packed-app, source-selection, attempt-suffix and continuation modes are outside this selection.

## Reuse the existing four Review steps

Extend the existing warm invocation, successful-warm capture, optional cold invocation and final inline validator to the five closed native cases. Keep one shared common validator body; do not copy four new validators or create a validation framework/module. Preserve the existing Review resolved modes, log names, receipt basenames, actions and every assertion.

1. **Warm:** invoke the existing `node scripts/legacy-agent-host/desktop-backend-smoke.ts` once with the selected original mode. The log is `host-emulated-${lane}-ui.log`; Review therefore keeps `host-emulated-opencode-v2-review-ui.log` exactly.
2. **Capture:** require exactly one original prepared row in that log, the canonical TEST root immediately under RUNNER_TEMP, exact `desktop-backend-receipt.json` basename, correct mode, outer PASS and the selected original proof owner. Retain current input source-head/clean tracked Git checks and exact before/after declared source arrays. Bind compiled bytes according to the epoch rules below. For an external cold mode, capture the full warm receipt SHA and publish only the original `LEGACY_DESKTOP_READBACK_ROOT` and `LEGACY_DESKTOP_READBACK_RECEIPT_SHA256` environment values. Do not overwrite the warm receipt.
3. **Cold, where selected:** invoke the same original backend once with the closed cold mode, generation v2 and original root/SHA. Its log is `host-emulated-${lane}-readback-ui.log`. Review retains `desktop-native-review-readback-receipt.json`; Quit and PNG use `desktop-readback-receipt.json` and the original `desktop-readback-app.log`. Resume has no external cold invocation: its existing helper already performs both app/Host epochs inside one backend call.
4. **Final validation:** use the existing failure-aware condition, one prepared record per invocation and one shared loop over `[warm, cold]` or `[warm]`. Require exact root/SHA joins and all original common receipt predicates, then branch only for the closed original proof owners below. Keep Review's summary name and false qualification fields; other lane summary/log names are covered by existing `host-emulated-*.json` / `*.log` artifacts.

Process exit 0 alone is insufficient for these native modes. Missing, ambiguous, prepared-only or INCOMPLETE evidence must fail the final validator. Preserve the common disqualifying fields: `failure`, `sourceFreezeFailure`, `nativeInputFreezeFailure`, `sentinelCensusFailure`, `logCleanupFailure` and `metadataObservationFailure`. Require `quitRequested === true` for every outer receipt. Both selected Quit helpers return to the common original close/finally; Resume's second epoch also reaches it. No blanket Quit exemption is justified.

Preserve the existing platform/Node, prepared input, profile/descriptor, Host/pnpm/Corepack path/hash, declared source roster, screenshot signature/SHA, sentinel and cleanup checks. Each outer receipt requires normal app exit 0 / signal null, captured Host observed and absent, empty owned remainder and no cleanupFailure. Keep the existing sentinel pre-Quit allowed-prefix and post-Quit refusal comparison; do not replace it with an empty census or a no-child rule.

Source identity comes from `host-emulated-inputs.sourceHead`, current clean tracked Git HEAD and original before/after source-hash arrays. Native receipts have no generic `receipt.source` field. The original `selectedNativeInputHashes*` arrays are Codex-specific and absent/empty here; they do not establish a final independent Bun/graph byte rehash. Keep actual preparation/provider pins and their existing checks without making that broader claim.

## Preserve compiled-epoch identity, especially Resume

For Review, Quit and PNG, retain Plan55's warm compiled-bundle check before the external cold invocation can rebuild the same dist paths. After cold completion, compare that cold receipt's own compiled pins with current `dist-electron`. Do not require two independently produced builds to be byte-identical.

Resume's single outer receipt retains the **first** epoch in top-level `compiledBundleHashesAfterStartup` and `coldResumeBoundary.firstEpoch.compiledBundleHashesAfterStartup`. Before the second spawn the original helper copies those exact files to `cold-resume-epoch1-bundles` and records `epoch1BundleSnapshot: { directory, files }`. In capture and final validation:

- Require the top-level first-epoch array, `firstEpoch` array and `epoch1BundleSnapshot.files` to agree. Require the canonical snapshot directory to be exactly `<root>/cold-resume-epoch1-bundles`; reuse the existing `compiledBundleHashes` data reader to compare its retained bytes with that first-epoch array.
- Compare `coldResumeBoundary.secondEpoch.compiledBundleHashesAfterStartup` with current `dist-electron`. Never compare top-level first-epoch pins with the rebuilt second-epoch dist or require equality between the two epochs.
- Require outer receipt PASS, `coldResumeBoundary.status === 'PASS'` and `secondEpoch.status === 'PASS'`. **`firstEpoch` has no status field.** Its retained app/Host identity is distinct from the second epoch; the top-level final cleanup belongs to the second epoch.
- Require first public Quit attempted, original first app exit 0 / signal null, empty first remainder, captured first Host absent and writer lock released before second spawn. The original Quit reply may be acknowledged or unconfirmed; physical exit is the controlling proof. Require `firstMetadataAbsentBeforeSecondSpawn === true`, the original second-epoch checkpoint/history unchanged witness, distinct app process group and Host PID, and the second/final cleanup predicates. Do not invent nested source receipts.

These checks consume already retained proof data and compiled files. They add no app/native action, observation timer or re-execution of a journey.

## Original mode-specific acceptance

Keep the Review branch's existing checks unchanged: original provider/version, exactly one `opencode-update-patch-v2` event, released Stop before Review, original events unchanged, six model observations with no failures, the original Keep/Reject/Undo/Redo persistence proof, full warm SHA in the cold Review proof, exact Task/file identity, no input replay or Runtime allocation, and original decision/event/runtime preservation.

| Journey | Required original receipt witnesses | Preserved boundary |
| --- | --- | --- |
| Active/queued Quit warm | `nativeSetup.status === 'ready'`; `nativeQuitUiProof.status === 'PASS'`; no pending scenario; before/after observation count 1; two original input intents; after session sealed and not ready, closed/released; `runtimeOutcome === 'closed-released'`, `debtRetained === false`; original child/group absence before fallback and writer-lock release all true. | The first input is unknown or terminal cancelled/failed; the queued input is cancelled without dispatch. No Stop precedes Quit. The original helper verifies no native-effect file and the held connection closes; do not invent an unrecorded connection boolean. |
| Pending-open Quit warm | `nativeSetup.status === 'opening'`; proof scenario `pending-open`; beforeQuit opening, not ready, not sealed, with zero inputs/interactions/model observations and one captured original native child; afterQuit physical absence and writer-lock release. | Preserve the existing disjunction: closed/released with no debt, **or** held/unknown with diagnostic `open-unknown`, sealed/not ready, `runtimeOutcome === 'held-unknown'`, `debtRetained === true`. Physical absence does not clear unresolved provider custody. Inputs/interactions remain empty. |
| Either Quit cold | `nativeQuitReadback.status === 'PASS'`, `sessionUnchanged`, `productUnchanged`, `unchangedThroughSecondQuit` all true; nativeAllocations 0 and metadataProcessCount 1; exact warm root/SHA. | This proof has no `nativeInputsReplayed` or `originalReceiptSha256` field. Join the warm SHA through the original readback environment and `coldOpenCodeMetadata.sourceSha256`. Preserve the original normalized product snapshot, including read-flag normalization, rather than introducing raw inbox-byte equality. |
| Checkpoint Resume | `resumeProvider === 'opencode'`; original V2 profile/version/executable/engine pins; `launchDialogProof`, `coldResumeBoundary`, `resumeDialogProof` PASS; Settings retained across cold startup; first Stop released; checkpoint/history unchanged before Resume; final model observations 11 and failures empty; `resumeDialogProof.phase === 'second-checkpoint-released'`; two session generations closed/released, second Stop released, same original nativeSession and `originalHistoryPrefixRetained === true`; final restoration closed/released/detached; recoverySnapshot present and recoverySnapshotFailure absent. | One original explicit Resume, one new Composer continuation and the second original Stop. Native history hashes describe the bounded ordered native-session serialization, not all SQLite bytes. No independent fresh Launch follows this Resume, and no Claude/Codex-only checkpoint field is required. |
| PNG warm | `conversationUiProof.status === 'PASS'`, nativeInputs 2, two original incomingIds, released custody and native child absent before Quit; `nativeChatAttachments.status === 'PASS'`; exact source/prepared PNG, 2×1 pixels and preview SHA; original second-message attachment metadata and nativeHistory; all three second-turn native model requests carry the prepared PNG SHA; failures empty. | Two physical Sends and one enabled Composer file-input selection; only the original conditional Expand and one original Stop. No native picker, second upload, text-file Download or effect substitution. The original helper requires canonical replies, native completed Task and ONE/TWO effect/history. |
| PNG cold | `savedNativeReadback.status === 'PASS'`, nativeInputsReplayed 0, nativeAllocations 0, metadataProcessCount 1, runtimeRecordUnchanged true; original attachment prepared bytes, sent-message preview and nativeHistory match warm proof. | No new upload, Send, Launch, restore or product effect. Its original field is `runtimeAllocationScope`; Review uses `nativeAllocationScope`. One read-only metadata child is separate from Runtime allocation and must close. |

The final workflow validates that the existing source-bound helpers completed and retained the correct witnesses. It must not substitute new receipt projections for their original native checks, actions or waits. A pending-open run that misses the original opening window remains a failure; no artificial delay, retry or readiness weakening is selected.

## Metadata and screenshot closure

Reuse the existing pure `assertDesktopMetadataLineageRetained` at blob `79c288d8cd5f6dc432177a2047ce517f174d11b4`. No native census, extra catalog request, synthetic child list or new metadata observer is added by the validator.

| Existing owner | Retained lineage and final closure |
| --- | --- |
| Review warm | Preserve existing `nativeReviewUiProof.metadataAfterStop` to `metadataAtHostClose` and `metadataAbsentBeforeHarnessCleanup`. |
| Quit/PNG warm | Use `nativeSetup.metadataAtRuntimeObservation` and its original `metadataAtHostClose`; require `nativeSetup.metadataAbsentBeforeHarnessCleanup`. The owner status is ready/opening, not a fabricated PASS enum. |
| Resume first Host | Use `launchDialogProof.metadataAfterStop` and `metadataAtHostClose`; require `coldResumeBoundary.firstMetadataAbsentBeforeSecondSpawn`. This first owner does not use the generic final `metadataAbsentBeforeHarnessCleanup` field. |
| Resume second Host | Use `resumeDialogProof.metadataAfterSecondStop` and `metadataAtHostClose`; require its `metadataAbsentBeforeHarnessCleanup`. |
| External cold readback | Use `coldOpenCodeMetadata.metadataAfterReadback` and `metadataAtHostClose`; require its absence-before-cleanup witness, full warm source SHA, original profile SHA and native Bun SHA, one captured metadata child and zero Runtime allocations. |

Preserve original owner/profile identities and nonempty final lifecycle events. In particular, metadataProcessCount 1 does not mean one Runtime child and must not be replaced by a universal no-child assertion.

Reuse the existing screenshot canonical path, PNG signature and SHA checks on the selected original proof owners. Review keeps `ui-native-v2-review-history.png` and `ui-native-review-host-restarted.png`. Active and pending Quit use `ui-native-before-quit.png` / `ui-native-pending-open-before-quit.png`, followed by `ui-native-quit-readback.png`. Resume retains `ui-original-launch-native.png` and `ui-original-resume-native.png`. PNG uses `ui-native-replies.png` and `ui-native-readback.png`. They are already covered by the existing `ui-*.png` artifact operand.

## Exactly eight additional artifact operands

Preserve all **72 existing ordered operands** byte-for-byte, including both existing Runtime-session globs, checkpoints, Tasks, Team state, commands/outbox, inboxes, PNG inputs/prepared bytes, screenshots and app/error logs. Append these eight existing outputs with the same `${{ runner.temp }}/TEST-desktop-backend-*/` prefix:

1. `desktop-readback-receipt.json`
2. `desktop-readback-app.log`
3. `cold-resume-epoch1-bundles/**`
4. `hoststore/teams/test-desktop-backend/.host-owner/launches/*.json`
5. `workspace/native-effect.txt`
6. `providers/opencode-v2/data/agent-teams-v2-*/opencode.sqlite`
7. `providers/opencode-v2/data/agent-teams-v2-*/opencode.sqlite-wal`
8. `providers/opencode-v2/data/agent-teams-v2-*/opencode.sqlite-shm`

The result is exactly **80 unique ordered operands**, with the original 72 as an unchanged prefix. Lane logs/summaries already match `host-emulated-*.log/json`. SQLite retention is restricted to the original selected OpenCode namespace; do not upload the whole provider HOME/tree. WAL/SHM may legitimately be absent. Retention adds no file-generation or native action, and the helper's native-session history hash is not renamed a whole-database hash.

## Review, original budgets and qualification limits

Before source publication, independent R2 must bind the full one-file preimage/postimage and verify the closed five-lane mapping, all four shared steps, absent optional selectors, one prepared epoch per invocation, per-mode proof owners, exact compiled-epoch handling, all original Review/common assertions, 132 unchanged lint operands and 72-to-80 artifact prefix preservation. Disclose the actual diff/line counts; do not compress existing code or introduce a file-size exception. A new source dependency, helper edit or oracle change requires a separately named prospective scope, not an implicit expansion of this workflow routing change.

Original time limits remain: 45 minutes per row / 5-minute aggregate; 180-second startup and V2 ready/open setup; ordinary 30-second UI reads; original 60-second Launch/Resume polls and explicit action observations; 45-second PNG visible replies and 15-second input/Task settlement; 20-second Quit observations; internal Resume 3-second Quit reply and 30-second physical exit; 5-second metadata log drain. Preparation and all original epochs consume the same row budget. No new timer, retry, replay, fallback cleanup, native invocation inside the verifier or guaranteed runtime-fit claim is selected.

This plan authorizes inert source preparation only after publication/readback, then normal reviewed exact-head CI. No local project/compiler/test/provider/GUI execution or CI dispatch/rerun is authorized by it. Missing, cancelled, queued or incomplete original jobs remain unqualified. A future positive result applies only to its exact OpenCode V2 lane, head and Darwin ARM64 tuple. It does not close genuine Claude/Codex, P08 same-Main Retry, P09 mutable-byte policy, full Windows W07 fresh Launch, mixed/captured-MCP completeness, M13, Ready/full Stage1, release/default activation or Stage2.
