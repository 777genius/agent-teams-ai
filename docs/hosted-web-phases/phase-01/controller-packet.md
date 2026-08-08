# PR #252 live-head sync controller packet

## Status and authority

- Phase/node: `phase-02` / `PR252.LATEST_BASE_SYNC`
- Revision: `pr252-live-head-sync-router-v2`
- Repository/PR: `777genius/agent-teams-ai#252`
- Admission and integration owner: `ProjectScopedControl`
- Attempt resolver and promotion actor: broker
- Runtime role: execution primitives only
- Terminal state: `HOLD`

This packet contains no author-time PR head or base SHA. It supersedes every durable source/base pin,
fixed conflict-path assumption, old-job continuation, and dirty-worktree reuse contract. The router
author edits only the seven declared paths, launches nothing, and ends `HOLD`.

## Outcome

The route admits at most one attempt, directly reruns its mechanical gates, obtains one independent
combined semantic review, and—only after exact acceptance—constructs, pushes, and proves a reviewed
true two-parent sync merge. Successful proof releases this gate but launches no successor.

## Immutable attempt contract

The runtime-owned `pr252.latest-base-binding/v1` contract is created before worker start and contains:

```text
attempt.id
attempt.canonicalHeadSha
attempt.resolvedBaseSha
attempt.materializationSourceSha = attempt.canonicalHeadSha
attempt.orderedParentShas = [attempt.canonicalHeadSha, attempt.resolvedBaseSha]
attempt.expectedOldHeadSha = attempt.canonicalHeadSha
attempt.conflictPaths
attempt.focusedTestCommands
attempt.resolvedAt
```

Both SHA fields must identify exact full commit objects. Every field is immutable after start.
`attempt.conflictPaths` is the complete sorted distinct conflict set from the ordered mechanical
merge, and every focused command is deterministic and repository-local. Results and reviews remain
runtime-owned; no repository handoff manifest or hash ledger is created.

## Atomic prepare/start

`ProjectScopedControl` admits one atomic transition. During it the broker:

1. verifies the router, canonical repository/PR, profile, scope, and empty attempt capacity;
2. resolves the live PR head and records it as `attempt.canonicalHeadSha`;
3. resolves the live PR base exactly once and records it as `attempt.resolvedBaseSha`;
4. proves both values identify exact commit objects;
5. materializes from `attempt.canonicalHeadSha`;
6. mechanically applies `attempt.resolvedBaseSha` as ordered second parent;
7. records the actual conflict paths and controller-selected focused tests; and
8. freezes the complete contract before starting one producer.

These steps either complete together or start no worker. The head cannot be substituted by the router
authoring commit, a branch name, a prior observation, another worker, or an abbreviated object ID.
The base cannot be re-resolved within the attempt.

## Product producer

The producer may edit only `attempt.conflictPaths`. Mechanically merged non-conflict bytes are
immutable. For every conflict, the producer preserves behavior from both
`attempt.canonicalHeadSha` and `attempt.resolvedBaseSha`; it may not select a whole side, weaken a
guard, hide a failure, skip a test, add a compatibility fallback, or perform unrelated cleanup.

If both behaviors cannot be preserved within exact scope, the producer records a blocker and returns
`HOLD`.

### Required gates

Before its result, the producer runs and records:

1. complete attempt-contract, commit-object, source, ordered-parent, and expected-old-head checks;
2. fresh live-head/base comparisons without rebinding;
3. exact conflict-only diff and non-conflict byte-equality proof;
4. zero unmerged index entries and zero unresolved conflict markers;
5. every command in `attempt.focusedTestCommands`, covering both parent behaviors;
6. `pnpm typecheck`;
7. `pnpm lint:fast:files -- <exact changed TypeScript/TSX conflict paths>` when non-empty;
8. `pnpm exec prettier --check <exact changed text conflict paths>`;
9. `git diff --check`; and
10. exact diff classification for binaries, symlinks, secrets, credentials, auth/provider payloads,
    private or real-project paths, destructive behavior, and unresolved placeholders.

The producer then self-reviews semantics, test adequacy, architecture, security, scope, and all gate
results. Its immutable runtime result is bound to the attempt and resolved tree SHA and ends `HOLD`.
It does not stage, commit, launch review, or authorize integration.

## Direct controller mechanical rerun

After producer `HOLD`, the controller first compares the live head and base to the immutable attempt
values. It then freshly materializes the producer tree and directly reruns the complete mechanical
gate set. Producer evidence is not a substitute. There is no mechanical-review worker.

Any mismatch or failure invalidates promotion eligibility and ends the attempt `HOLD`.

## Independent combined semantic review

Only after the controller pass and another head/base equality check may exactly one fresh independent
reviewer start. The reviewer is independent of the router author, producer, prior invalidated attempt
actors, and broker and has no edit, repair, rebind, commit, merge, push, or retry authority.

The reviewer examines both parents, every resolution, the complete tree, focused-test adequacy,
architecture, security, trust boundaries, data exposure, producer self-review, and controller
evidence. Only `ACCEPT` with P0/P1/P2 `0/0/0`, bound to the same attempt/base/head/tree, creates a
promotion edge. Every other result returns `HOLD` with no integration.

## Drift

The controller compares the live PR head and base:

1. before direct mechanical rerun;
2. before reviewer admission;
3. immediately before merge construction and push; and
4. during post-push GitHub proof.

Any inequality invalidates only that attempt and all of its results. After it is terminal, the same
packet may admit a fresh atomic attempt. Drift never mutates an attempt, revives an old source pin,
reuses a worker, or requires a docs revision.

## True-merge promotion and proof

After exact semantic acceptance, the broker rechecks the immutable bindings, then creates one merge
commit whose:

```text
parents[0] = attempt.canonicalHeadSha
parents[1] = attempt.resolvedBaseSha
tree       = attempt.acceptedReviewedTreeSha
```

The broker proves the commit has exactly those two parents and that tree. It pushes with
`attempt.canonicalHeadSha` as the expected old PR head, proves the remote and GitHub PR head equal
the merge commit, proves the GitHub base still equals `attempt.resolvedBaseSha`, and waits for a
resolved non-conflicting mergeability result for that exact pair.

One-parent, squash, patch-only, reversed-parent, octopus, whole-side, tree-mismatched, force-substituted,
unreviewed, or `UNKNOWN`/`CONFLICTING` output is not success.

## Ownership and stop policy

The router owns exactly the seven paths listed in `EXECUTION_INDEX.json`. No product, test, Phase 2
packet, evidence, runtime, config, dependency, lockfile, or handoff path is writable to the router.

Stop on any authority, attempt, head, base, source, parent-order, conflict-path, byte, command, test,
review, tree, push, remote, or GitHub-proof mismatch. Nothing authorizes real-project access, team
launch/provisioning, product terminal/smoke/provider/auth flow, raw lifecycle calls, other
repositories, broad docs work, dependency changes, Fast mode, or automatic successor launch. End
`HOLD`.
