# Script typing and retained failure observations — 2026-11-18

## Scope and delivery

This follow-up belongs to Draft PR1192, branch `fix/frontend-parity-completion-20261113`. Its exact parent is `408fc8fce6eb00c5f790e9e29f896d9fef8080d9` (tree `a4bf5b291b7ef3b2a85430a5ed1df763c3055227`); the target base remains `8d46f13fe87b4a25156b6be8331119eb8d0f790e`.

The complete parent cohort is terminal: **29 original pull_request attempt1 workflows, 8 SUCCESS / 7 FAILURE / 14 SKIPPED**. Every run is permanently retired after its first-terminal collection. No later request to those runs, jobs, logs or artifacts is permitted. Immutable saved evidence and source blobs remain usable.

This change corrects the two source-level typing seams that produced eight script-project diagnostics and adds bounded observations for unresolved original failures. **It does not qualify full frontend/Host/provider E2E.** New compiler, test, lint, build and runtime results are all **NOT RUN** at authoring time. Existing parent passes do not qualify changed postimages.

## What changes

| Area | Change | Preserved behavior |
| --- | --- | --- |
| Script types | Give the existing reader refusal arrow an explicit callable `never` type; add `.js` to one existing type-only NodeNext import. | Same throw, schema, guards and runtime paths; no cast or weakened acceptance. |
| Native source failure | Print one optional, UTF-8-bounded 16 KiB frame containing the already-retained runtime projection and Codex readiness observation. | Existing first-refusal frame and error identity; no new observation, request, clock or wait. The new frame follows scenario-owned cleanup attempts and precedes the outer Sentinel cleanup. |
| Desktop Review | Project retained startup/Review marker states only for the original failed Review mode. | No timed-out callsite or cause is inferred. |
| Retained original / Resume | Add separate failure projections: fixed dialog occurrence flags for retained-original, distinct first/successor epochs and closed phase/recovery marker presence for Resume. | Partial samples remain partial. Missing markers mean not recorded, not absence of action or effects. |
| M16 Create | Attach a closed, bounded marker to the existing provider authority Notice and read it within the existing finite-Create unavailable-target evaluation. | The marker receives already-computed checks. No repeated authority/readiness computation; original Create predicate, 30-second budget, owner checks and input/error path remain unchanged. |
| Source binding | Add the new helper, Notice, Notice test and deadline test to the existing supplementary source roster. | Original Set union, before/after freeze calls, frozen 800-line main roster and workflow dispatch remain unchanged. |

The M16 marker contains at most four allowlisted providers, fixed statuses and booleans. It uses own data properties, canonical printable ASCII and a 1,536-byte transport limit. Malformed, accessor, identity-mismatched, duplicate, noncanonical or oversized input becomes one fixed unknown marker. It emits no model names, accounts, credentials, paths, raw details or error messages. The marker describes an earlier render/DOM observation; it is not fresh launch authority or a complete explanation of every disabled predicate.

The new Review projection is bounded to 2,048 ASCII characters; each new retained-original/Resume projection is bounded to 4,096. Selected own-data fields only are traversed. PASS and unrelated modes do not traverse the new diagnostic markers. The changes add bounded descriptor, serialization and DOM attribute work; no zero-timing-impact claim is made.

## Actual parent execution

These results belong only to `408fc8fc`. The [evidence bundle](evidence/head408-followups-20261118.json) contains immutable original terminal receipts, job/step metadata, source pins and reviews. The [full frontend roster](evidence/head408-frontend-roster.json) preserves all 2,185 distinct reporter paths.

| Original workflow or gate | Actual result | Qualification limit |
| --- | --- | --- |
| Teams Desktop | All three Windows, Ubuntu and macOS jobs SUCCESS, including app typechecks and original Create/Back/Resume/Copy/Launch steps. | Job/step evidence; successful logs and ZIP bytes were not inspected. |
| Safe frontend shards | All four SUCCESS: 26,232 PASS / 38 SKIP across 2,185 unique files (2,178 passed files, 7 wholly skipped files). | No overlapping path counted twice. These shards are part of Host Emulated, not extra workflows. |
| Host Emulated | 29 nonaggregate jobs: 25 Desktop (17 SUCCESS / 8 FAILURE) plus 4 successful frontend shards. Failed aggregate makes 30 jobs, 21 SUCCESS / 9 FAILURE. | 28 artifacts recorded as metadata only; ZIP contents were not downloaded. |
| Host process | Linux and both macOS jobs SUCCESS; both Windows jobs FAILURE. | Windows native-readiness cause remains unresolved. |
| Main | 15 jobs: 1 SUCCESS / 3 FAILURE / 11 SKIPPED. Root app typecheck and seven configuration commands completed; scripts typecheck then reported eight diagnostics. | Later Host/MCP types and Fast lint were not run. The retained lane failed strict types before its finite tests and original Desktop run. |
| Packaged | Classifier SUCCESS; all five platforms failed on the same eight script diagnostics; aggregate FAILURE. | Packaging and runtime steps were skipped. Five artifacts are metadata only. |
| Stage1 static preflight | 7 SUCCESS / 2 Darwin FAILURE. Static Host types/SPI and Linux/Windows positive witnesses ran. | Darwin P09 remains unqualified. |
| Remaining 23 workflows | 7 SUCCESS / 2 audit FAILURE / 14 SKIPPED. | A skip provides no runtime qualification. |

The final Host Emulated quit-active job succeeded through its original journey, cold app/Host restart readback and final source/receipt/cleanup validator. This is original step-status evidence, not an independent inspection of the artifact.

The 29 new producer cases from the parent are present in two passing Vitest files: 19 helper cases plus 18 Main cases (8 original, 10 new). Their reporter evidence is at file/count granularity, not individual titles. The separate Runtime diagnostic suite has seven named current PASS witnesses. All nine repaired setup cases and the new contradictory Host identity case also have named current PASS witnesses. Shared Linux finite tests were 472/472 PASS; Darwin was 467 PASS / 5 SKIP. The separate installer suite was 7/7 PASS. The Team lane's Host runtime/contracts command passed 201/201 and the OpenCode diagnostics command passed 132 with 2 skips before the later script-type refusal prevented Team UI.

## Eight Host Emulated matrix refusals

| Lane | First observed refusal | What remains unknown |
| --- | --- | --- |
| Team | Seven reader narrowing errors plus one type-only import extension error in full scripts typecheck. | Candidate corrections require new compiler execution; original Team UI did not run. |
| V2 Review on Darwin | Generic `Runtime.evaluate` timeout with no intervening stage lines and empty source frames. | Exact thrown callsite and cause. |
| M16 import lifecycle | Original Create remained disabled through its original 30-second initial-read budget, 96 reads/owner checks; no hover or press was reached. | Which complete admission predicate held it. Existing DOM/source evidence establishes the all-checks-checking Notice presentation branch only. |
| Retained original | After the original Launch input, the expected confirmation was not found in 221 reads within the original 30-second window. | Async launch/import result and reason for the missing expected confirmation. |
| Resume | Generic `Runtime.evaluate` timeout after preparation. | Exact phase/callsite; a later recovery request can also fail. |
| V2 membership | Before initial Launch, the retained direct-Host-child sample had one unmatched child where zero were expected. | Child identity/role and cause; the sample preceded the later peer-effects wait. Settings and its validator passed separately. |
| Attachments | Original `team.launch.start` returned `{ok:false, code:"hold", outcome:"unknown"}`. | Internal phase/category; the saved public reply contains no more detailed cause. |
| Collaboration | Original Restore Carol click returned; the original 75-second passive poll did not see a new completed roster command. | Actual command/native/factory result; the original predicate's local command value was not retained on timeout. |

The M16 producer/Notice trace does not justify changing launch guards. Absent Host proof, displayed models or an all-checking notice do not establish authoritative scoped provider readiness. The frozen oversized `CreateTeamDialog.tsx` is unchanged.

For attachments, closed runtime-open diagnostics are written to the application error file; absence from stdout is not absence of an event or an effect. No diagnostic archive bytes from the parent are available, and retired artifacts will not be reopened.

## Windows, P09 and audit boundaries

The Windows ARM Codex case retained 127 reads with a last running/unresolved sample. Its 15,179.8226 ms interval starts at a later completion marker, not the original absolute deadline; it is not proof of that deadline's overrun. A final resume overlapped cleanup and does not establish an antecedent cause. Pre-witness-wait handle rows do not prove cleanup debt. Outer Sentinel cleanup remains unknown.

Windows x64 OpenCode Team A retained 66 reads, ending held/unknown with nativeReady false and open outcome unknown. The actual reference-expiry observation was 162 ms late. No evidence-backed removable work or behavior fix has been established. The new stdout frame only exposes already-retained samples, which may belong to a previous Team B sample and remain non-atomic.

Darwin P09 still has executed changed-byte evidence on ARM; x64 has the original errno13/code-signing refusal plus separate changed-byte execution evidence. Reap/group-absence diagnostics do not close the arbitrary-writer, selected-pathname, same-inode/open-FD/mmap requirement. Neither a broader writer trust boundary nor immutable-version execution semantics is silently selected.

Both audit failures have the same parsed audit JSON hash, 79 vulnerability records (1 low, 17 moderate, 61 high, 0 critical), 21 distinct advisories and one distinct high advisory, `GHSA-fc5q-39xc-vjpf` for `picomatch <=4.0.7`. No dependency waiver or override is introduced. Any earlier registry/advisory observation is dated evidence, not a claim about an unqueried current release.

## Candidate validation and exact sources

This candidate adds **31 test cases**: one native source-tail test with ten finite exercises, 15 Desktop summary cases, and 15 M16 Notice/codec/control cases (6 + 9). Their existing Node/Vitest dispatch paths were source-verified. **All 31 are authored NOT RUN.** Existing test prefixes are preserved except narrow finite Create fixture expectations for the newly explicit unknown marker.

The prepared repository/dependencies and pinned local runtime were not present after the environment change. Shell access returned, but no dependency install, runtime substitution, local app/native/browser retry or real Claude/Codex execution was performed. This is not a claim that execution tools are globally unavailable.

Independent reviews and root review checked exact immutable postimage hashes, whole-file inverses, selected-field privacy, error preservation, source binding and textual line counts. These are source-only results. The repository cap command, compiler, tests, lint and build remain NOT RUN. Eight changed production TypeScript files are at or below 800 physical lines.

| Source | Physical lines | SHA-256 |
| --- | ---: | --- |
| `scripts/legacy-agent-host/desktop-retained-open-diagnostics.ts` | 228 | `4d08dd2eb96b9f44bf370d8f63f1eedc7daca36c8064e7cb60f266a7e623077c` |
| `src/features/agent-backend/main/infrastructure/stopped-import/retainedLegacyOpenDiagnosticContract.ts` | 52 | `7918e41e7692d4f9c2440488f4ccde5e195929948df41686ec59ed8b5602239b` |
| `tools/owned-process-broker/nativeEmulatedSourceScenario.ts` | 800 | `51331fd064ee3cf2938891fae36eb4cabf2874ffce7be1e8231d3b30c7f1680a` |
| `packages/legacy-agent-host/tests/runtime-team-host.test.ts` | 4674 | `bfe8fd389bd9c57b1ac2596c27bf55df118dfb29d4365815d7143475286f5b30` |
| `scripts/legacy-agent-host/desktop-proof-evidence.ts` | 717 | `de68457199bc9c24e7d2442ab936849225b5ae4d63d6b99a873e10337edc4ff9` |
| `scripts/legacy-agent-host/desktop-backend-observations.test.ts` | 2696 | `8d916d7aa6ab2ff8df343f028ebb444fa02be12beee69a860258476c2ec5c2e4` |
| `src/shared/utils/providerLaunchAuthorityMarker.ts` | 162 | `81fd52b0a798bcdefcfb912eb4a0d4cdb9a0dcfe5ed879eaf26ad6c5eae52602` |
| `src/renderer/components/team/dialogs/ProviderLaunchAuthorityNotice.tsx` | 98 | `5f736ea59431b77957469a5d1f3f9248efdd5e27e5730ef37d9851f4ebffd3eb` |
| `src/renderer/components/team/dialogs/ProviderLaunchAuthorityNotice.test.tsx` | 300 | `5c834f17d53c5e7b06673c9c4506853baa9adb502b3d8258649148c89f12478d` |
| `scripts/legacy-agent-host/desktop-ui-controls.ts` | 770 | `11396934656152e42498f68b2aaab144a545b3a158b8d63d4907046823892d10` |
| `scripts/legacy-agent-host/desktop-ui-controls-deadline.test.ts` | 815 | `41f85552abfc510df60889655e4caeb42a17c977cc693c604f1bfcc11922b5e1` |
| `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts` | 386 | `c03ca25255dd573c02d828fc6a47a1ff37f6fc850d69abcd32843e45db4e2f34` |

Full Git blob IDs, base hashes, dispatch pins, author manifests and independent reviews are in the evidence bundle. Historical embedded manifests retain their creation-time PENDING/HOLD fields verbatim; the bundle's final review index identifies the later scoped review. Those fields never certify execution.

Publication stays within the existing Draft PR and uses an expected-parent, non-force push immediately after commit creation. No Ready transition, merge, main update, release, default activation, Stage2, manual CI dispatch, rerun or cancellation is included. The next original attempt1 cohort must execute the new head before any runtime result is claimed.
