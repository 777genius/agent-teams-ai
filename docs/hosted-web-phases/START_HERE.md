# Hosted-web execution: start here

> Current route: `phase-01-pr252-task-provenance-remediation-router-r2` corrects only the rejected
> r3 remediation launch. It conditionally authorizes one reviewed-dirty continuation of the exact
> existing r3 job and workspace, followed by one fresh independent reviewer. This seven-document
> router launches nothing and ends `HOLD`.

Phase 0 and accepted Phase 1 history remain frozen. The only current executable node is
`PR252-task-provenance-remediation`. Root stays orchestrator; `controller-v17` stays exactly live and
is neither replaced nor restarted.

## Deterministic reading order

1. `AGENTS.md`
2. This file
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/controller-packet.md`
7. `docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md`
8. `CLAUDE.md`
9. `AGENT_CRITICAL_GUARDRAILS.md`
10. `docs/hosted-web-phases/PACKET_STANDARD.md`
11. Only the five producer-owned product/test paths listed in the lane packet

Do not recursively inspect rejected job state, fetch, launch an app/runtime/team, access a real
project, or substitute a moving ref for a stored immutable target. The continued worker may inspect
only the named reviewed-output manifest and exact existing job/workspace state needed by this route.

## Rejection consumed without replaying its candidate

Reviewer r4 returned `FORMAL REJECT`, P0/P1/P2 `0/1/0`, for producer r3. The sole P1 demonstrated
that, without destination `reconcile` or task `creationCommand`, a `findById` fallback returned an
unrelated task with the requested ID, subject `UNRELATED SUBJECT`, and outcome `Executed`. Every
other semantic requirement and check passed.

The successor is bound to useful-handoff SHA-256
`f810a0aa191e82316737c5c0069ee6225597d8a477d77b50c57bc3fd931fe579` and rejected full-diff
SHA-256 `cb534246905f6fd7cc03b0b761018157ed12d204d11819f0978915af7c778491`. The first is the
identity of the existing workspace patch that must be preserved; the second is review provenance
only. The rejected full diff is not applied, materialized, or integrated, and this remediation is not
a clean rewrite.

The authoritative rejected `ReviewedWorkerOutput` is
`1796cc59fb1a6c291c54a589ef8a0e10d694b8c61128a5486e5307831afaee9b`. Its manifest binds
`decision=rejected`, worker and task
`agent-teams-hosted-web-refactor-pr252-semantic-conflict-resolution-v17-r3`, workspace
`/var/data/agent-teams-hosted-web-refactor/worktrees/pr252-semantic-conflict-resolution-v17-r3`,
base `3256ee3b5b8e81b144aa0a14eac1bca080c9b779`, patch `f810a0aa...`, and the exact five
owned paths. The current accepted and pushed predecessor router is
`f5e3ce8257d05c6ff2a5c19e944d75999868550d`.

## Corrected current-base authority

- Accepted/pushed predecessor router:
  `f5e3ce8257d05c6ff2a5c19e944d75999868550d`.
- Continued r3 workspace base/`HEAD` and target-side merge baseline:
  `3256ee3b5b8e81b144aa0a14eac1bca080c9b779`.
- Pinned current real base and merge source:
  `origin/refactor/team-provisioning-round2-reapply@e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`.
- Direct remote proof: `git ls-remote origin
refs/heads/refactor/team-provisioning-round2-reapply` returned that exact `e9ffa30c...` commit.
- GitHub PR `baseOid` `d2585e7634800eb795644c4b6d0e8baf5f81c98f` is stale. It is 52 commits behind
  `e9ffa30c...`.
- Former source `7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0` is also an ancestor of
  `e9ffa30c...`; it is provenance only and is not the active merge source.
- Fresh `merge-tree(3256ee3b..., e9ffa30c...)` proves exactly the same five conflict paths recorded
  in the lane packet.

The standalone-normal-push interpretation is superseded. The conflict route remains current.

## Same-job reviewed-dirty remediation

After this router receives independent `ACCEPT`, is integrated, and is pushed,
`ProjectScopedControl` resolves that pushed target once as `storedRouterCommit`. It first proves the
named r3 job is stopped, the rejected output still has the exact binding above, and the existing
workspace still has `HEAD=3256ee3b...`, an empty index, exactly the five dirty paths, and raw patch
SHA-256 `f810a0aa...`. Any drift ends `HOLD`.

It then invokes existing `codex_goal_project_start` exactly once for that same r3 job with
`reviewedOutputId=1796cc59...`, `forceStart=true`, `confirmStart=true`, and
`dependencyBootstrap=install`. No refill, new job, new task, new worktree, duplicate, fetch,
checkout, reset, rebase, clean rewrite, or rejected-patch replay is authorized. The workspace `HEAD`
intentionally remains `3256ee3b...`; therefore the worker reads the accepted r2 authority with
`git show <storedRouterCommit>:<path>` and does not move `HEAD`.

The worker preserves the existing five-path patch byte-for-byte except for the P1 subject-safety fix
in `TaskBoardCommandFacade.ts` and the exact tenth regression in its E2E test. It keeps destination
reconciliation optional and restores target-safe payload/trimmed-subject validation without
requiring provenance. An unrelated same-ID task throws and terminally classifies
`TaskBoardCreateDestinationConflictError`; it can never report a success outcome. The index remains
empty throughout.

The continued r3 worker self-reviews, emits one immutable output, and ends `HOLD`. Then
`ProjectScopedControl` admits exactly one fresh independent reviewer through
`codex_goal_project_prepare_verifier`. The continuation reuses r3's existing worker profile; the
fresh reviewer uses `gpt-5.6-sol`, `xhigh`, and `serviceTier: "fast"`, with no machine `fastMode`
field. Only independent
`ACCEPT` with P0/P1/P2 `0/0/0` permits ordered broker integration.

Immediately before integration, the broker must rerun the exact `git ls-remote` query and require
the remote branch head still equals `e9ffa30c...`. A moved head ends `HOLD` and requires review of a
new pinned base. If unchanged, the broker creates the true merge with ordered parents
`[storedRouterCommit, e9ffa30c...]`, materializes source non-conflicts, applies the accepted
five-path resolution, reruns every gate, runs the final source-only command-identity test, creates a
conventional merge commit, and pushes.

## Authority and HOLD

All inherited focused checks, native exact seven-diagnostic TypeScript baseline, self-review,
independent review, exact five-path scope, empty index, conflict, secret/provider, private-path, and
textual/non-binary gates remain required. P1.R2, P1.I, P1.F, and Phase 2+ remain blocked until the
validated ordered merge is pushed. This router changes exactly seven docs, performs no lifecycle or
Git mutation, and ends `HOLD`.
