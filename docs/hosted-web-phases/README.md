# Hosted Web execution router

> Current authority: `phase-01-pr252-task-provenance-remediation-router-r2` corrects only producer
> r3's remediation launch. It conditionally routes one reviewed-dirty continuation of the exact
> rejected r3 job/workspace, then one fresh independent reviewer. This docs transition launches
> nothing and ends `HOLD`.

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
`cb534246905f6fd7cc03b0b761018157ed12d204d11819f0978915af7c778491` bind the successor. The
first is the raw existing workspace patch identity and preserved remediation input. The second is
provenance-only: it is not a carrier and must not be replayed, materialized, or directly integrated.
The successor is a remediation of that reviewed work, not a clean rewrite.

Rejected `ReviewedWorkerOutput`
`1796cc59fb1a6c291c54a589ef8a0e10d694b8c61128a5486e5307831afaee9b` binds
`decision=rejected`, r3 worker/task identity, the existing r3 workspace, base/`HEAD` `3256ee3b...`,
raw patch `f810a0aa...`, and the exact five paths. The accepted and pushed predecessor authority is
`f5e3ce8257d05c6ff2a5c19e944d75999868550d`.

Direct `git ls-remote` authority supersedes the stale GitHub PR `baseOid`. The current real base and
pinned merge source is
`origin/refactor/team-provisioning-round2-reapply@e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`.
Stale `d2585e7634800eb795644c4b6d0e8baf5f81c98f` is its ancestor by 52 commits, and old source
`7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0` is also its ancestor. Fresh merge-tree proof between
continued-workspace target baseline `3256ee3b5b8e81b144aa0a14eac1bca080c9b779` and
`e9ffa30c...` reports the same exact five conflicts. Therefore the conflict route, ordered true
merge, and final source-only test remain real; the standalone-normal-push interpretation is
superseded.

## Authorized successor

After this exact seven-document router is independently accepted, integrated, and pushed,
`ProjectScopedControl` resolves its pushed commit once, revalidates the rejected-output manifest and
the existing reviewed-dirty workspace snapshot, and invokes `codex_goal_project_start` exactly once
for the same r3 job. The call binds the reviewed output above and uses `forceStart=true`,
`confirmStart=true`, and `dependencyBootstrap=install`. It creates no job, task, or worktree.

The worker keeps `HEAD=3256ee3b...` and reads r2 authority only with
`git show <storedRouterCommit>:<path>`. It preserves the existing five-path patch and changes only
`TaskBoardCommandFacade.ts` for the P1 subject-safety fix and `TaskBoardCommands.e2e.test.ts` for the
exact tenth `UNRELATED SUBJECT` regression. Destination reconciliation remains optional; no
`creationCommand`, `createdBy`, or relation provenance is required. The index remains empty. Fetch,
checkout, reset, rebase, clean rewrite, rejected-patch replay, a new job/worktree, and duplicates are
forbidden.

The continued r3 self-review ends `HOLD`. Then exactly one fresh independent reviewer is admitted
with `codex_goal_project_prepare_verifier`. The reviewer uses model `gpt-5.6-sol`, reasoning effort
`xhigh`, and `serviceTier: "fast"`; machine request envelopes contain no `fastMode` field.
Only fresh `ACCEPT` with P0/P1/P2 `0/0/0` permits broker integration.

Immediately before integration, the broker reruns `git ls-remote origin
refs/heads/refactor/team-provisioning-round2-reapply`. It must still return exactly `e9ffa30c...` or
the route ends `HOLD` for a new-base review. With an unchanged source, integration creates a true
merge with ordered parents `[storedRouterCommit, e9ffa30c...]`, proves the exact five
conflicts, materializes source non-conflicts, applies the accepted output, reruns every focused gate,
runs `test/renderer/utils/createTaskCommandIdentity.test.ts`, conventionally commits, and pushes.

## HOLD

All inherited tests, the exact native seven-diagnostic TypeScript baseline, bounded lint, Prettier,
index-empty, diff/ownership, conflict, secret, private-path, and binary gates remain mandatory.
P1.R2, P1.I, P1.F, and Phase 2+ remain blocked until the validated ordered merge is pushed. This docs
router performs no launch, fetch, stage, commit, merge, push, or lifecycle action. End `HOLD`.
