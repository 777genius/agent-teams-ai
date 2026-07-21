# PR #252 live-head conflict-resolution lane

## Authority

- Phase/node: `phase-02` / `PR252.SYNC.PRODUCER`
- Lane: `pr252-latest-base-conflict-resolution`
- Revision: `pr252-live-head-sync-router-v2`
- Repository/PR: `777genius/agent-teams-ai#252`
- Product capacity: one attempt and one producer
- Mechanical evaluator: controller directly; no mechanical reviewer
- Semantic reviewer: one fresh independent combined reviewer
- Terminal state: `HOLD`

This lane contains no durable PR head, base, or conflict-path pin. Before worker start, the broker
atomically records:

```text
attempt.canonicalHeadSha
attempt.resolvedBaseSha
attempt.materializationSourceSha = attempt.canonicalHeadSha
attempt.orderedParentShas = [attempt.canonicalHeadSha, attempt.resolvedBaseSha]
attempt.expectedOldHeadSha = attempt.canonicalHeadSha
attempt.conflictPaths
attempt.focusedTestCommands
```

The broker resolves the live head and resolves the live base exactly once. Both are immutable for the
attempt. A partial, ambiguous, non-commit, duplicate-capacity, or mismatched binding starts no worker.

## Mandatory reads

Read accepted router bytes and attempt inputs in this order:

1. `AGENTS.md`
2. `docs/hosted-web-phases/START_HERE.md`
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/README.md`
7. `docs/hosted-web-phases/phase-01/controller-packet.md`
8. `docs/hosted-web-phases/phase-01/execution-dag.md`
9. this lane packet
10. `CLAUDE.md`
11. `AGENT_CRITICAL_GUARDRAILS.md`
12. `docs/FEATURE_ARCHITECTURE_STANDARD.md`
13. `docs/hosted-web-phases/PACKET_STANDARD.md`
14. `docs/hosted-web-phases/ORCHESTRATION_GUARDS.md`
15. the immutable attempt contract
16. every path in `attempt.conflictPaths` and command in `attempt.focusedTestCommands`

Do not inspect unrelated projects, workers, repositories, evidence, provider state, team state, or
user/private directories.

## Exact producer scope

`attempt.conflictPaths` is the complete writable set derived from the ordered mechanical merge. The
producer may resolve those paths and nothing else. It must not add, remove, rename, move, reformat,
or compile-repair another path; mutate a mechanically merged non-conflict byte; import an old patch
or prior attempt tree; change either bound SHA; or widen scope.

If preservation needs a non-conflict edit, report a blocker and end `HOLD`.

## Both-parent contract

For every conflict, preserve the relevant behavior from:

1. `attempt.canonicalHeadSha`; and
2. `attempt.resolvedBaseSha`.

Resolve overlap deliberately at the smallest conflict site. Whole-side selection, behavior deletion,
weakened validation, hidden fallback, skipped test, compatibility shim, unrelated cleanup, or a test
expectation changed to conceal a regression fails the lane.

When requirements are incompatible inside exact scope, record the conflict; do not guess.

## Focused tests and mechanical gates

Run every exact `attempt.focusedTestCommands` entry. The frozen set covers each conflict and the
relevant behavior from both parents. A command that cannot run is a failed gate, not permission to
replace it or install dependencies.

Also run and record:

1. attempt schema, exact commit-object, source, ordered-parent, and expected-old-head validation;
2. fresh live-head/base comparison without rebinding;
3. exact conflict-only diff and non-conflict byte-equality proof;
4. zero unmerged index entries and unresolved conflict markers;
5. `pnpm typecheck`;
6. `pnpm lint:fast:files -- <exact changed TypeScript/TSX conflict paths>` when non-empty;
7. `pnpm exec prettier --check <exact changed text conflict paths>`;
8. `git diff --check`;
9. binary, symlink, NUL, secret, credential, auth/provider payload, private/real-project path, and
   destructive-behavior classification; and
10. proof that no install/update, real-project, team launch/provisioning, product terminal/smoke,
    provider/auth, raw lifecycle, other-repository, broad-docs, or Fast activity occurred.

Any mismatch or unclassified result fails the attempt.

## Self-review and result

Reread the complete resolved diff and review attempt binding, both-parent behavior preservation,
test adequacy, integration coherence, architecture, security, exact scope, command results, and
remaining risk.

Return one immutable runtime-owned result bound to the attempt and resolved tree SHA, with exact
commands/exits, self-review, P0/P1/P2 findings, blockers, and `terminalState: HOLD`. Write no
repository handoff artifact; do not stage, commit, launch review, integrate, or authorize a successor.

## Controller, review, and promotion

After producer `HOLD`, the controller compares the live head/base, freshly materializes the exact
producer tree, and directly reruns all mechanical gates. There is no separate mechanical reviewer.

After another equality check, exactly one fresh independent combined
integration/architecture/security semantic reviewer examines both parents, every resolution, the
complete tree, tests, architecture, security, producer self-review, and controller evidence. The
reviewer cannot edit or repair. Only exact `ACCEPT` with P0/P1/P2 `0/0/0` permits promotion.

Immediately before promotion, the broker proves the live head equals `attempt.canonicalHeadSha` and
the live base equals `attempt.resolvedBaseSha`, then creates:

```text
parents[0] = attempt.canonicalHeadSha
parents[1] = attempt.resolvedBaseSha
tree       = attempt.acceptedReviewedTreeSha
```

It pushes with `attempt.canonicalHeadSha` as expected old head and proves the remote and GitHub head
equal the merge commit, the GitHub base still equals `attempt.resolvedBaseSha`, and mergeability is
resolved and non-conflicting for that exact pair.

## Drift and HOLD

Later head or base drift invalidates only the bound attempt and every attempt result. After terminal
state and clear capacity, the controller may admit a fresh atomic attempt using this same revision.
It never retargets a running attempt or reuses a worker.

Stop on any router, repository, PR, attempt, head, base, commit-object, source, parent-order, conflict,
scope, byte, command, test, review, tree, push, remote, or GitHub-proof mismatch. End `HOLD`; launch no
successor.
