# Hosted Web execution router

> Current authority: `phase-01-pr252-task-provenance-remediation-router-r1` consumes producer r3's
> independent r4 `FORMAL REJECT` and conditionally routes one hash-bound true-merge remediation
> producer, then one fresh independent reviewer. This docs transition launches nothing and ends
> `HOLD`.

Always begin with [`START_HERE.md`](START_HERE.md). Machine-readable authority is
[`EXECUTION_INDEX.json`](EXECUTION_INDEX.json); the current Phase 1 controller and lane packets are
the only executable packets.

## Current route

Reviewer r4 rejected producer r3 at P0/P1/P2 `0/1/0`. The sole P1 proved that a
`TaskBoardCommandFacade` fallback could accept an unrelated same-ID task when destination
`reconcile` and task `creationCommand` were absent; the executed result returned subject
`UNRELATED SUBJECT`. All other r3 semantics and checks passed.

Useful handoff
`f810a0aa191e82316737c5c0069ee6225597d8a477d77b50c57bc3fd931fe579` and full rejected diff
`cb534246905f6fd7cc03b0b761018157ed12d204d11819f0978915af7c778491` bind the successor as
review provenance/reference. The full diff is not a carrier and must not be materialized or directly
integrated. The successor is a remediation of that reviewed work, not a clean rewrite.

Direct `git ls-remote` authority supersedes the stale GitHub PR `baseOid`. The current real base and
pinned merge source is
`origin/refactor/team-provisioning-round2-reapply@e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`.
Stale `d2585e7634800eb795644c4b6d0e8baf5f81c98f` is its ancestor by 52 commits, and old source
`7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0` is also its ancestor. Fresh merge-tree proof between
canonical/head `3256ee3b5b8e81b144aa0a14eac1bca080c9b779` and `e9ffa30c...` reports the same exact five
conflicts. Therefore the conflict route, ordered true merge, and final source-only test remain real;
the standalone-normal-push interpretation is superseded.

## Authorized successor

After this exact seven-document router is independently accepted, integrated, and pushed,
`ProjectScopedControl` may resolve its pushed commit once and admit exactly one serial producer with
`codex_goal_project_refill_worker`. The producer owns the exact five conflict paths. It may introduce
new remediation semantics only in `TaskBoardCommandFacade.ts` and `TaskBoardCommands.e2e.test.ts`
unless an owned-path compile-coherence change is proved necessary.

It materializes a fresh true two-parent merge against pinned `e9ffa30c...`, uses the r3 handoff and
full-diff hashes only as immutable review reference, and preserves all passing r3 semantics. It keeps
destination reconciliation optional and restores target-safe payload/trimmed-subject validation at
every `findById` fallback success without requiring `creationCommand`, `createdBy`, or relation
provenance. A mismatch is a terminal `TaskBoardCreateDestinationConflictError`, never success. One
focused `UNRELATED SUBJECT` negative regression is added to the combined nine-case E2E suite, for ten
cases total.

Producer self-review ends `HOLD`. Then exactly one fresh independent reviewer is admitted with
`codex_goal_project_prepare_verifier`. Producer and reviewer use model `gpt-5.6-sol`, reasoning
effort `xhigh`, and `serviceTier: "fast"`; machine request envelopes contain no `fastMode` field.
Only fresh `ACCEPT` with P0/P1/P2 `0/0/0` permits broker integration.

Immediately before integration, the broker reruns `git ls-remote origin
refs/heads/refactor/team-provisioning-round2-reapply`. It must still return exactly `e9ffa30c...` or
the route ends `HOLD` for a new-base review. With an unchanged source, integration creates a true
merge with ordered parents `[stored accepted router target, e9ffa30c...]`, proves the exact five
conflicts, materializes source non-conflicts, applies the accepted output, reruns every focused gate,
runs `test/renderer/utils/createTaskCommandIdentity.test.ts`, conventionally commits, and pushes.

## HOLD

All inherited tests, the exact native seven-diagnostic TypeScript baseline, bounded lint, Prettier,
index-empty, diff/ownership, conflict, secret, private-path, and binary gates remain mandatory.
P1.R2, P1.I, P1.F, and Phase 2+ remain blocked until the validated ordered merge is pushed. This docs
router performs no launch, fetch, stage, commit, merge, push, or lifecycle action. End `HOLD`.
