# PR #982 — P1 and G1c integration checkpoint

This records checked implementation, independent review and the remaining gates. It does not qualify a release, activate Host by default, or authorize merging to main.

## Reviewed plans and reconciliation

P1's admission design was published in `1e64ea3`; its read-only attachment namespace refinement preceded implementation in `cc3f1b5`. P1b's configured Restart plan was published in `c8c4dc9`. The final G1c supplement was published in `d3db042` before its production edits: [original handoff supplement](oauth-original-handoff-supplement.md).

Concurrent changes were retained, including the selection smoke selector, lossless MCP briefing pages, process snapshot pagination, original OAuth cleanup fencing, configured Restart lineage, and native/Desktop group catalog pagination. Integration did not replace their commits or widen native deadlines. The independent launch-origin implementation in the shared branch is retained byte-for-byte; our twelve lineage regressions and full Host controls verify it instead of installing a second implementation.

## P1 behavior

Fresh human/native messages, task notifications, cross-team deliveries and group fan-out validate the complete captured provider input before their first product publication. The shared attachment projector checks original artifact metadata, bytes, route and profile identity, and formats the same text that native dispatch will receive. The admission path uses a read-only owner namespace and cannot create attachment storage as a side effect of a refusal.

The generic Runtime fallback remains 64 KiB. Host composition uses the existing 8 MiB technical ceiling while enforcing each captured provider's smaller input limit. Cross-team input accepts the same 50,000 JavaScript string units as Desktop. UTF-8 bytes, attachment decoration, group envelopes and actual context space are accounted for separately; accepted text is never truncated. Active Runtime input count and aggregate byte bounds remain in force.

A new input is refused before receipt/inbox/task/group publication when its known formatted size cannot fit. Existing original receipts and admitted deliveries retain their replay and recovery semantics. A stale original profile is held before group publication even when no attachment is present. MCP expiry still permits a valid business message to enter its durable queue; dispatch and provider readiness continue to reject the expired native dependency.

The shared preparation ceiling now validates a retained large original input consistently during cold loading. Context preparation computes remaining space from the actual attachment-decorated input, while native slash commands and required context-epoch proofs retain their original rules.

## G1c behavior

The final 606-line OAuth owner keeps the existing journal and provider adapters. One synchronous original-record boundary compares the complete last confirmed durable predecessor immediately before a write. Only an attempted write that throws sets publication uncertainty. A missing, corrupt or changed record cannot be overwritten by a later cleanup continuation.

Original receipt and deadline guards surround both native authorization and native completion. Foreign selectors are rejected before touching the active conversation. Private authorization reads refuse changed or expired originals without initiating cleanup. Cleanup still closes the original native capture once; its live `cancelling` projection is separate from the confirmed durable predecessor, and any first publication refusal prevents a second write after close.

Cold recovery follows actual persisted custody. A terminal record can be released after confirmed physical cleanup even if its write subsequently throws; the live owner conservatively holds its uncertainty without rewriting those released bytes.

Root and both independent reviewers approved the actual owner SHA-256 `e11c1629381d4713b8aafef68f7a39fc8b3056ed514c9985fed15c9c444dbd0f` and test SHA-256 `f1a9ddb257a850cf49a27dec3175ea8bbf442c968ada5576c7604016237fc452`.

## Executed verification

All runs below used pinned Node 24.21.0 and the existing TypeScript 7.0.2 dependency, without installing or changing runtime/dependency pins. Source and tests were preserved across executor recovery and compared by hash before integration. Native provider services and real user projects were not used.

| Check                                                    | Observed result and scope                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1c finite regression against unchanged integrated owner | 32 cases: 13 PASS / 19 FAIL. The failures include eighteen new functional cases and the unchanged blocked-close progress regression.                                                                                                           |
| G1c management cohort after the fix                      | 121/121 PASS, zero skipped, covering OAuth, external durable cleanup, credentials, fingerprint helper, store, identity, OpenCode management and Claude management Host controls.                                                               |
| Checked Host build                                       | PASS on the integrated P1/G1c source; repeated after concurrent group catalog changes.                                                                                                                                                         |
| Full Host test typecheck                                 | PASS on combined P1/G1c. A later concurrent catalog fixture exposed a DTO/JSON boundary type error; the corrected fixture mirrors the production serialization boundary. The complete integrated test typecheck then PASSed in 24.487 seconds. |
| Launch/Runtime Host cohort                               | 116/116 PASS, including configured Restart, retained lineage, cold read/replay and expired MCP dispatch controls. Uses the canonical concurrent launch implementation.                                                                         |
| Team/task cohort                                         | 107/107 PASS, including pre-publication refusal, notification recovery, original delivery and task state controls.                                                                                                                             |
| Attachment/context cohort                                | 31/31 PASS.                                                                                                                                                                                                                                    |
| Group/cross-team cohort                                  | 36/36 PASS, including actual filesystem refusal before group publication on original profile drift.                                                                                                                                            |
| Runtime/cold preparation cohort                          | 29/29 PASS on the unchanged reviewed Runtime implementation.                                                                                                                                                                                   |
| Main cross-team cohort                                   | 27/27 PASS, including the real HTTP composition path and the 50,000-unit frontend boundary.                                                                                                                                                    |
| Main process/read cohort                                 | 21/21 PASS: actual Host pager through Main projection and complete Desktop reconstruction, external regression controls, and existing bounded product reads.                                                                                   |
| Concurrent group/MCP integration cohort                  | 47/47 PASS, including real retained GroupCommands catalog, native MCP formatter, existing groups, task association and native authority controls.                                                                                              |
| Structural guards                                        | Source-size, Team Provisioning architecture and forbidden runtime artifacts PASS before the final publication; source caps and legacy exceptions are unchanged.                                                                                |

These are separate cohorts, not a claim that their summed counts are unique tests. Historical passes are not substituted for later source changes. The process pagination fixture for an accepted 420 KiB summary now explicitly supplies the capable 8 MiB TEST input budget it requires; other fixtures retain the 64 KiB fallback, and all data-preservation assertions remain unchanged.

The canonical full Desktop `pnpm typecheck` was killed with exit 137 before producing a diagnostic. Canonical full `pnpm lint` was also terminated without a verdict. Neither is recorded as a pass. Changed Main files passed focused formatting/lint checks; exact-head full CI and native/Desktop acceptance are still required. Cancelled workflows for superseded commits are not qualification of this implementation.

## Continuation

[G1d](oauth-start-fingerprint-plan.md) is independently reviewed and published with this checkpoint before its implementation. It addresses the two remaining OAuth-start field fingerprints and cancellation during original Main target discovery. G2's separate credential/configuration/profile identity analysis is not closed by G1c or G1d.

The newly paginated Desktop group catalog also requires the attention-name reader to collect the complete original catalog. That discovered consumer gap is covered by [the reviewed attention continuation](group-catalog-attention-plan.md), published before its production edits. The 2026-11-28 reconciliation preserves the incoming canonical collector and captures the original scalar team name before asynchronous renderer reads. The current collector/renderer/captured-read/attention cohort passed 43/43 cases, including 1100 groups, names and unread counts beyond the first page, the 128-page ceiling, and context/owner loss without partial publication.

Current-source OAuth and process execution is recorded in [the G1d reconciliation](oauth-start-fingerprint-plan.md#current-source-reconciliation-and-local-execution--2026-11-28) and [the Desktop process qualification](desktop-process-catalog-plan.md#local-qualification-after-executor-recovery--2026-11-28). Those local passes do not replace current-head full CI, genuine native qualification or the remaining G2 review. No release, main merge, default activation or native pin change is included here.
