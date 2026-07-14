# Hosted Web Phase 1

Current authority is `phase-01-pr252-task-provenance-remediation-router-r2`; terminal state is
`HOLD`. Accepted Phase 0 and Phase 1 history remains unchanged.

Independent reviewer r4 formally rejected producer r3 at P0/P1/P2 `0/1/0`. Its only finding was a
`TaskBoardCommandFacade.findById` false success: with no destination `reconcile` and no task
`creationCommand`, an unrelated same-ID task with subject `UNRELATED SUBJECT` was returned as
`Executed`. Every other r3 semantic and gate passed.

Useful handoff SHA-256
`f810a0aa191e82316737c5c0069ee6225597d8a477d77b50c57bc3fd931fe579` and rejected five-path diff
SHA-256 `cb534246905f6fd7cc03b0b761018157ed12d204d11819f0978915af7c778491` bind this successor. The
first identifies the preserved workspace patch; the second remains provenance-only and is not
materialized, replayed, or directly integrated. The successor is not a clean rewrite.

Rejected `ReviewedWorkerOutput`
`1796cc59fb1a6c291c54a589ef8a0e10d694b8c61128a5486e5307831afaee9b` binds
`decision=rejected`, the exact r3 worker/task, workspace, base/`HEAD` `3256ee3b...`, patch
`f810a0aa...`, and five paths. Accepted and pushed predecessor router commit
`f5e3ce8257d05c6ff2a5c19e944d75999868550d` is immutable history.

The active merge source/current real base is
`origin/refactor/team-provisioning-round2-reapply@e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`, proven
by direct `git ls-remote`. GitHub's `d2585e7...` base is stale and 52 commits behind; former source
`7afc908c...` is an ancestor of `e9ffa30c...`, not the current source. Fresh merge-tree proof against
the continued-workspace target baseline `3256ee3b...` preserves the exact five-conflict route.

After the seven-doc router is accepted, integrated, and pushed, `ProjectScopedControl` stores the
pushed router commit, proves the exact reviewed-dirty r3 snapshot is unchanged and the index empty,
then calls existing `codex_goal_project_start` once for that same job with the exact reviewed output
above, `forceStart=true`, `confirmStart=true`, and `dependencyBootstrap=install`. No new job, task,
worktree, or duplicate is authorized.

The r3 worker intentionally remains at `HEAD=3256ee3b...` and reads the accepted r2 docs with
`git show <storedRouterCommit>:<path>`. It preserves the five-path patch, changing only the facade for
the P1 subject-safety fix and its E2E test for the exact tenth case. No fetch, checkout, reset, rebase,
clean rewrite, rejected-patch replay, or staging is allowed.

The continued r3 self-review ends `HOLD`; one fresh independent reviewer follows. The reviewer uses
`gpt-5.6-sol`, `xhigh`, and `serviceTier: "fast"`, with no machine `fastMode` property. Only
independent `ACCEPT` at P0/P1/P2 `0/0/0` permits integration. Immediately before that integration,
the broker must prove the
remote source head still equals `e9ffa30c...`; drift ends `HOLD`. An unchanged source permits only the
ordered true merge `[storedRouterCommit, e9ffa30c...]`, followed by all final-shape gates and the
source-only command-identity test.

The authoritative dependency projection is [`execution-dag.md`](execution-dag.md). P1.R2, P1.I,
P1.F, and Phase 2+ remain blocked pending the validated merge push. This docs router changes exactly
seven documentation paths, launches nothing, performs no Git/lifecycle mutation, and ends `HOLD`.
