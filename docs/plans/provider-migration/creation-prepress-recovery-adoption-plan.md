# Creation pre-press recovery adoption plan

Status: reviewed two-path adoption plan before target implementation. Adopt the common test helper and controls from Goal `4457a9350dc4925ec0982baa38e0401c7b0f1a78`; do not adopt the Goal feature through this change.

## Evidence, source and scope

The original Windows Creation artifact `15273063364` showed a target unavailable between the successful readiness wait and the final pre-press observation. A temporary layout change in this interval must be handled within the existing click's deadline before any input. The separate historical Review/History failure uses a different helper and is not qualified by this adoption.

Exactly two existing paths are adopted:

1. `scripts/e2e/teams-create-page-desktop.mjs` — source blob `5edfe4852999834e84111f9b9f406dfc5ba4b1e4`.
2. `scripts/e2e/teams-create-page-owned-processes.test.mjs` — source blob `48f79707090d25ecd693b302d6aad8135b66d4ce`.

Root checked these paths are byte-identical at Goal `4457a9350dc4925ec0982baa38e0401c7b0f1a78` and its current merge `41b59a7a66dae96550aa35841d0a6493196a3b45`. The complete target `73c7723c504327c8ba42cf656e7a39912af5e11e` to incoming diff was independently reviewed. No Goal import or product behavior is added.

## Behavior and invariants

The ordinary click branch may re-observe only an explicit `null` final DOM result before a press. The actual DOM expression uses null for a disconnected, disabled, animated or obstructed target. `undefined`, `false`, zero and an empty string are malformed CDP replies and retain the original missing-target refusal without a second observation.

The original 30,000 ms absolute cutoff is captured once. Every repeated wait receives only `remaining()`. The final strict `Date.now() < cutoff` check remains before `mousePressed`; a ready coordinate sample arriving exactly at the cutoff is too late. No loop surrounds an issued `mousePressed` or `mouseReleased`, and a press transport failure is never retried. The separately prepared schedule target keeps its original release/finally behavior.

The patch adds five real VM-backed controls: a pre-press obstruction recovers to the final visible point with one press/release; repeated obstruction consumes the original deadline without input; a failed issued press is not repeated; malformed falsy final replies are refused without re-observation; and recovered coordinates at 30,000/30,001 ms are refused before input. Existing task-tab, ordinary and schedule observations remain covered.

## Review and verification

Root reviewed the target-to-incoming diff and actual `CdpClient` behavior. The independent provider source R2 reviewed both the complete adoption and the later `!target` to `target === null` refinement, with the real VM harness. It approved only these two paths.

On exact Goal `4457a9350dc4925ec0982baa38e0401c7b0f1a78`, root ran both complete helper test files using pinned Node 24.21.0: 47 tests passed, zero failed or skipped. This is source-runtime evidence for those common files, not a physical Windows/Desktop result or target-branch qualification.

Publish this plan first. Then adopt the exact source blobs, rerun the same two complete helper test files in the target branch, and run applicable inherited strict checks and guards with the other reviewed test-only changes. Preserve source equality and normal hook evidence in the execution record. Obtain current ready-PR CI through normal source publication. Do not extend a deadline, repeat a product action, change a runner or manually restart CI.
