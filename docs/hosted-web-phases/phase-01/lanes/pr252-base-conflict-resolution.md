# PR #252 task-provenance same-job continuation lane

## Authority

- Phase/node: `phase-01` / `PR252-task-provenance-remediation`
- Lane: `pr252-task-provenance-remediation`
- Revision: `phase-01-pr252-task-provenance-remediation-router-r2`
- Root: orchestrator only
- Durable controller: `controller-v17`, exactly `live=true`; no replacement or restart
- Admission/integration owner: `ProjectScopedControl`
- Producer continuation: existing `codex_goal_project_start` for the exact r3 job
- Reviewer: `codex_goal_project_prepare_verifier`, `workerRole: reviewer`, `reviewKind: review`
- Worker profile: `gpt-5.6-sol`, `xhigh`, `serviceTier: "fast"`; omit `fastMode`
- Conditional capacity: one same-job reviewed-dirty r3 continuation, then one fresh independent
  reviewer
- Router and continued-r3 terminal state: `HOLD`

No worker starts until this exact seven-document router is independently accepted, integrated, and
pushed. This docs author starts none.

## Consumed rejection

Independent reviewer r4 returned `FORMAL REJECT` for producer r3, P0/P1/P2 `0/1/0`. Its only P1
proved that a `TaskBoardCommandFacade.findById` fallback could accept an unrelated same-ID task when
destination `reconcile` and task `creationCommand` were absent. The executed proof returned subject
`UNRELATED SUBJECT` with outcome `Executed`. All other semantics and checks passed.

The successor verifies and binds these immutable rejection records:

| Record                           | Identity                                                           | Active use                           |
| -------------------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| Rejected `ReviewedWorkerOutput`  | `1796cc59fb1a6c291c54a589ef8a0e10d694b8c61128a5486e5307831afaee9b` | same-job continuation admission      |
| Existing workspace patch         | `f810a0aa191e82316737c5c0069ee6225597d8a477d77b50c57bc3fd931fe579` | snapshot identity and preserved work |
| Complete rejected five-path diff | `cb534246905f6fd7cc03b0b761018157ed12d204d11819f0978915af7c778491` | review provenance/reference only     |

The reviewed-output manifest must still say `decision=rejected` and bind both `workerJobId` and
`taskId` to `agent-teams-hosted-web-refactor-pr252-semantic-conflict-resolution-v17-r3`, source
workspace `/var/data/agent-teams-hosted-web-refactor/worktrees/pr252-semantic-conflict-resolution-v17-r3`,
base `3256ee3b5b8e81b144aa0a14eac1bca080c9b779`, patch `f810a0aa...`, and exactly the five paths
below. The rejected full diff is not a merge carrier. Applying, replaying, materializing, or directly
integrating it is forbidden. This continuation repairs the existing reviewed r3 work; a clean rewrite
is forbidden.

## Current real base and conflict proof

The active merge source is
`origin/refactor/team-provisioning-round2-reapply@e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`.
Direct `git ls-remote origin refs/heads/refactor/team-provisioning-round2-reapply` returned that exact
commit. GitHub PR `baseOid` `d2585e7634800eb795644c4b6d0e8baf5f81c98f` is stale; local ancestry
proves it is 52 commits behind `e9ffa30c...`. Old source
`7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0` is also an ancestor of `e9ffa30c...` and has no active
source authority.

Fresh `git merge-tree --write-tree 3256ee3b5b8e81b144aa0a14eac1bca080c9b779
e9ffa30cc016ad3cb833fcc0a138fa4f026eb850` proves exactly the five conflicts below. This corrects
the stale standalone-normal-push interpretation; true-merge topology, ordered parents, source
non-conflict materialization, and the final source-only test remain required.

## Stored target and launch contract

Accepted and pushed predecessor router commit
`f5e3ce8257d05c6ff2a5c19e944d75999868550d` is the base of this correction. After r2 router
acceptance/integration/push, `ProjectScopedControl` resolves its pushed full SHA exactly once as
`storedRouterCommit`. That value is authority for the continuation directive, reviewer target,
`mark_reviewed` target, integration target, and the true merge's first parent. It is not the r3
workspace `HEAD` and never causes the workspace to move.

Immediately before continuation, the controller proves the existing job is not active, the rejected
reviewed-output manifest still matches, and the workspace has `HEAD=3256ee3b...`, an empty index,
exactly the five dirty paths below, no untracked path, and raw `git diff` SHA-256 `f810a0aa...`. It
then calls `codex_goal_project_start` exactly once with:

```json
{
  "jobId": "agent-teams-hosted-web-refactor-pr252-semantic-conflict-resolution-v17-r3",
  "reviewedOutputId": "1796cc59fb1a6c291c54a589ef8a0e10d694b8c61128a5486e5307831afaee9b",
  "forceStart": true,
  "confirmStart": true,
  "dependencyBootstrap": "install",
  "confirmDependencyBootstrap": true
}
```

The project-scoped call also binds `controller-v17`, the existing registry, and the integration
controller working directory. It is a continuation, not a refill. No new job, task, prompt-owned
workspace, or worktree may be created, and a concurrent/already-started r3 result fails closed rather
than starting a duplicate.

## Mandatory reads

The workspace `HEAD` intentionally remains `3256ee3b...`, so the continued worker must read each
accepted r2 authority path below with `git show <storedRouterCommit>:<path>` rather than from the
worktree. Read, in order:

1. `AGENTS.md`
2. `docs/hosted-web-phases/START_HERE.md`
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/controller-packet.md`
7. This lane packet
8. `CLAUDE.md`
9. `AGENT_CRITICAL_GUARDRAILS.md`
10. `docs/hosted-web-phases/PACKET_STANDARD.md`
11. The exact five current dirty workspace paths

The controller verifies the single named reviewed-output manifest before start. The worker does not
recursively read rejected job state or unrelated product, test, research, or evidence paths. Do not
fetch or move `HEAD` to obtain r2 authority.

## Exact exclusive producer scope

The complete ordered `ownedPaths` list and legal conflict set is:

1. `src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts`
2. `src/main/services/team/TeamDataService.ts`
3. `src/renderer/components/team/TeamDetailView.tsx`
4. `test/features/task-board-commands/TaskBoardCommands.e2e.test.ts`
5. `test/main/services/team/TeamDataService.test.ts`

The continued worker preserves the existing five-path patch and emits an exact five-path output. New
bytes are allowed only in paths 1 and 4 for the named P1 fix and test. Paths 2, 3, and 5 must remain
byte-identical to their `f810a0aa...` patch sections. Existing unrelated hunks in paths 1 and 4 also
remain intact. No compile-coherence exception and no sixth path are authorized.

## Required remediation semantics

1. Continue the exact reviewed-dirty r3 workspace in place. Do not materialize another merge, replay
   either rejected artifact, or copy any complete source blob.
2. Preserve every r3 semantic that passed r4, including partial-create recovery, stale-command
   recovery, idempotent retry identity, JSON validation, the coherent `TeamDataService` reconcile
   port, the dual-signature `TeamDetailView` adapter, and existing relation normalization.
3. Keep destination `reconcile` optional. Use it when available. Its absence must not disable durable
   creation or invent an unknown success.
4. At every `findById` fallback success site, pass the requested payload and require target-safe
   subject validation: the found task subject must equal the requested string subject after trimming.
   Same ID alone never proves success.
5. Do not require or compare `creationCommand`, `createdBy`, or relations as provenance. The fix is
   payload/subject safety, not a new provenance contract.
6. A found unrelated same-ID task throws `TaskBoardCreateDestinationConflictError`, is classified
   `Terminal`, and can never become `Executed`, `Retried`, `Reconciled`, `Replayed`, or another
   success outcome.
7. Retain the existing nine E2E cases, then add one exact tenth regression with subject
   `UNRELATED SUBJECT`, no destination `reconcile`, and no task `creationCommand`. The combined suite
   has exactly ten cases.
8. Leave no conflict marker, duplicate branch implementation, unreachable compatibility shim,
   widened writer scope, or source-only API mismatch.

## Continued worker execution and handoff

The worker must prove stored r2 authority, fixed workspace base/`HEAD`, pinned source identity,
reviewed-output identity/decision, both patch hashes, exact five-path ownership, an empty index, no
clean rewrite or rejected-diff replay, and the exact semantic contract above. It performs a complete
self-review with explicit P0/P1/P2 counts, emits one immutable runtime-owned output with
`nextAction: "integration-review"`, and returns `HOLD`.

The worker may not fetch, checkout, reset, rebase, clean, launch an app/runtime/team, access a real
project, stage, merge, commit, push, start the reviewer, or authorize its own integration. It may not
create or request a job, task, workspace, worktree, or duplicate continuation.

## Required continued-worker and reviewer gates

Run independently in both materializations:

```bash
git diff --cached --quiet
pnpm exec vitest run test/features/task-board-commands/TaskBoardCommands.e2e.test.ts
pnpm exec vitest run test/main/services/team/TeamDataService.test.ts
node scripts/hosted-web/phase-0/final-gate/normalize-typescript-diagnostics.mjs --mode milestone
pnpm lint:fast:files -- src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts src/main/services/team/TeamDataService.ts src/renderer/components/team/TeamDetailView.tsx test/features/task-board-commands/TaskBoardCommands.e2e.test.ts test/main/services/team/TeamDataService.test.ts
pnpm exec prettier --check src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts src/main/services/team/TeamDataService.ts src/renderer/components/team/TeamDetailView.tsx test/features/task-board-commands/TaskBoardCommands.e2e.test.ts test/main/services/team/TeamDataService.test.ts
git diff --check
```

The focused tests include exactly ten TaskBoard E2E cases. The native TypeScript result must contain
exactly the inherited seven Phase 0 diagnostics:

- `auth-artifacts-spike.test.ts`: TS7016 at 25:8; TS7031 at 66:31; TS18046 at 117:68; TS7031 at
  413:48; TS7031 at 733:10;
- `evidence-scanner.test.ts`: TS7016 at 12:8; and
- `scan-runtime-surfaces.test.ts`: TS2352 at 162:44.

Any added, removed, moved, or changed diagnostic fails.

Also prove the reviewed-output binding, pre-continuation patch snapshot, preserved untouched patch
sections, pinned merge-tree identity and exact five conflicts, semantic no-whole-blob-copy/no-clean-
rewrite behavior, the unrelated-same-ID terminal never-success result, and exact-scope conflict-
marker, secret/auth/provider, private/user/real-project-path, and textual/non-binary scans over all
five owned paths. Every match must be classified.

## Independent review

After continued r3 `HOLD`, `ProjectScopedControl` invokes
`codex_goal_project_prepare_verifier` exactly once. The reviewer is fresh and independent of the
router author, continued r3, and r4. It uses `gpt-5.6-sol`, `xhigh`, `serviceTier: "fast"`, the
no-write policy, stored r2 authority, base `3256ee3b...`, pinned source, and the SHA-256 of the sole
immutable continued output. It is also independent of rejected earlier PR252 workers and prior
accepted workers. It cannot repair, refill, re-resolve, stage, merge, commit, or push. It reruns every
check and returns explicit `ACCEPT` or `REJECT`; only P0/P1/P2 `0/0/0` may accept.

## Reviewed ordered integration

Immediately before integration, `ProjectScopedControl` runs exactly:

```bash
git ls-remote origin refs/heads/refactor/team-provisioning-round2-reapply
```

The single returned branch head must still be
`e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`. If it moved, stop at `HOLD`; do not merge, fetch a
replacement, or silently rebind. A new-base review/router is required.

Only with unchanged source and reviewer `ACCEPT` may the broker create a true merge with ordered
parents `[storedRouterCommit, e9ffa30cc016ad3cb833fcc0a138fa4f026eb850]`. It proves the
conflict set is exactly the five owned paths, materializes the pinned source's non-conflict paths,
applies only the accepted five-path output, reruns all producer/reviewer gates on the final shape, and
then runs:

```bash
pnpm exec vitest run test/renderer/utils/createTaskCommandIdentity.test.ts
```

That source-only test must pass before the conventional merge commit and push. A one-parent, squash,
patch-only, reversed-parent, moving-source, extra-conflict, clean-rewrite, rejected-diff replay,
whole-blob-copy, or gate-failing result is rejected and not pushed.

## Stop and HOLD

Stop on predecessor/router authority, reviewed-output decision or identity, job/task/workspace,
base/`HEAD`, patch, index, scope, source, conflict-set, continuation request, duplicate activity,
model/effort/tier, controller, independence, diagnostic, safety, semantic, test, review, or integration
drift. P1.R2, P1.I, P1.F, and Phase 2+ remain blocked until the validated ordered merge is pushed.

This router launches nothing and performs no fetch, stage, commit, merge, push, or lifecycle action.
End `HOLD`.
