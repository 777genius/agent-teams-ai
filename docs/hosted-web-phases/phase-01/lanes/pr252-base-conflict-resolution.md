# PR #252 task-provenance five-path remediation lane

## Authority

- Phase/node: `phase-01` / `PR252-task-provenance-remediation`
- Lane: `pr252-task-provenance-remediation`
- Revision: `phase-01-pr252-task-provenance-remediation-router-r1`
- Root: orchestrator only
- Durable controller: `controller-v17`, exactly `live=true`; no replacement or restart
- Admission/integration owner: `ProjectScopedControl`
- Producer: `codex_goal_project_refill_worker`, `workerRole: producer`
- Reviewer: `codex_goal_project_prepare_verifier`, `workerRole: reviewer`, `reviewKind: review`
- Worker profile: `gpt-5.6-sol`, `xhigh`, `serviceTier: "fast"`; omit `fastMode`
- Conditional capacity: one serial producer, then one fresh independent reviewer
- Router and producer terminal state: `HOLD`

No worker starts until this exact seven-document router is independently accepted, integrated, and
pushed. This docs author starts none.

## Consumed rejection

Independent reviewer r4 returned `FORMAL REJECT` for producer r3, P0/P1/P2 `0/1/0`. Its only P1
proved that a `TaskBoardCommandFacade.findById` fallback could accept an unrelated same-ID task when
destination `reconcile` and task `creationCommand` were absent. The executed proof returned subject
`UNRELATED SUBJECT` with outcome `Executed`. All other semantics and checks passed.

The successor verifies and binds two immutable rejection records:

| Record                           | SHA-256                                                            | Active use                             |
| -------------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Useful handoff                   | `f810a0aa191e82316737c5c0069ee6225597d8a477d77b50c57bc3fd931fe579` | strict input and remediation reference |
| Complete rejected five-path diff | `cb534246905f6fd7cc03b0b761018157ed12d204d11819f0978915af7c778491` | review provenance/reference only       |

The rejected diff is not a merge carrier. Applying, materializing, or directly integrating it is
forbidden. This successor remediates the reviewed r3 result; a clean rewrite is forbidden.

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

After router acceptance/integration/push, `ProjectScopedControl` resolves the pushed full SHA exactly
once. The stored value binds producer/reviewer `canonicalSha`, `phaseStartSha`, plan target, worktree
`HEAD`, review target, integration target, and the true merge's first parent. Fixed target-side
`baseSha` is `3256ee3b5b8e81b144aa0a14eac1bca080c9b779`; the distinct pinned merge source/current real
base is `e9ffa30c...` and is carried outside the strict worker contract.

The strict contracts retain the controller packet's exact 18-key shape. Producer `inputPatchHash` is
the useful handoff hash; reviewer `inputPatchHash` is the SHA-256 of the new immutable producer
output. Outer request envelopes specify only supported worker fields, including
`serviceTier: "fast"` and no `fastMode`. Requests fail closed on bindings, placeholders, missing or
extra keys, stale targets, wrong hashes, wrong source, or scope drift.

## Mandatory reads

Read, in order:

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
11. The exact five owned paths at the stored target and pinned source commits

Do not recursively read rejected job state or unrelated product, test, research, or evidence paths.

## Exact exclusive producer scope

The complete ordered `ownedPaths` list and legal conflict set is:

1. `src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts`
2. `src/main/services/team/TeamDataService.ts`
3. `src/renderer/components/team/TeamDetailView.tsx`
4. `test/features/task-board-commands/TaskBoardCommands.e2e.test.ts`
5. `test/main/services/team/TeamDataService.test.ts`

The producer resolves all five merge conflicts semantically and emits an exact five-path output. New
remediation semantics are limited to paths 1 and 4. Paths 2, 3, and 5 preserve the already-passing r3
resolution unless a compile-coherence change is necessary, narrow, explained, and covered by the
same gates. No sixth path is writable.

## Required remediation semantics

1. Materialize a fresh merge attempt with stored target first and pinned `e9ffa30c...` second. Do not
   replay the rejected diff or copy any complete source blob.
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
7. Retain the target E2E suite's four cases and the source suite's five cases, then add one exact
   regression with subject `UNRELATED SUBJECT`, no destination `reconcile`, and no task
   `creationCommand`. The combined suite has exactly ten cases.
8. Leave no conflict marker, duplicate branch implementation, unreachable compatibility shim,
   widened writer scope, or source-only API mismatch.

## Producer execution and handoff

The producer must prove stored target equality, fixed target-side base, pinned source identity, both
rejection hashes, exact five-path ownership, an empty index, no clean rewrite or rejected-diff
materialization, and the exact semantic contract above. It performs a complete self-review with
explicit P0/P1/P2 counts, emits one immutable runtime-owned output with
`nextAction: "integration-review"`, and returns `HOLD`.

The producer may not fetch, launch an app/runtime/team, access a real project, stage, merge, commit,
push, start the reviewer, or authorize its own integration.

## Required producer and reviewer gates

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
exactly the inherited seven Phase 0 diagnostics: five in `auth-artifacts-spike.test.ts`, one in
`evidence-scanner.test.ts`, and one in `scan-runtime-surfaces.test.ts`; any added, removed, moved, or
changed diagnostic fails.

Also prove both rejection hashes, the fresh merge-tree identity and exact five conflicts, semantic
no-whole-blob-copy/no-clean-rewrite behavior, the unrelated-same-ID terminal never-success result,
and exact-scope conflict-marker, secret/auth/provider, private/user/real-project-path, and
textual/non-binary scans over all five owned paths. Every match must be classified.

## Independent review

After producer `HOLD`, `ProjectScopedControl` invokes
`codex_goal_project_prepare_verifier` exactly once. The reviewer is fresh and independent of the
router author, producer, r3, and r4. It uses the same model/effort/tier, the no-write policy, the same
stored target and pinned source, and the SHA-256 of the immutable producer output. It cannot repair,
refill, re-resolve, stage, merge, commit, or push. It reruns every check and returns explicit `ACCEPT`
or `REJECT`; only P0/P1/P2 `0/0/0` may accept.

## Reviewed ordered integration

Immediately before integration, `ProjectScopedControl` runs exactly:

```bash
git ls-remote origin refs/heads/refactor/team-provisioning-round2-reapply
```

The single returned branch head must still be
`e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`. If it moved, stop at `HOLD`; do not merge, fetch a
replacement, or silently rebind. A new-base review/router is required.

Only with unchanged source and reviewer `ACCEPT` may the broker create a true merge with ordered
parents `[stored accepted router target, e9ffa30cc016ad3cb833fcc0a138fa4f026eb850]`. It proves the
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

Stop on target, source, hash, scope, conflict-set, request-shape, model/effort/tier, controller,
independence, diagnostic, safety, semantic, test, review, or integration drift. P1.R2, P1.I, P1.F,
and Phase 2+ remain blocked until the validated ordered merge is pushed.

This router launches nothing and performs no fetch, stage, commit, merge, push, or lifecycle action.
End `HOLD`.
