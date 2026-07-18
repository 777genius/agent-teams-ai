# PR #252 stable latest-base conflict-resolution lane

## Authority

- Phase/node: `phase-02` / `PR252.SYNC.PRODUCER`
- Lane: `pr252-latest-base-conflict-resolution`
- Revision: `pr252-latest-base-sync-router-v1`
- Repository/PR: `777genius/agent-teams-ai#252`
- Active router/canonical head and product source:
  `81e79295e199bad0e6bf426537564ea7bc67dfcd`
- Historical accepted product-wave provenance:
  `eee2389f7ee9300df93ef02d92e9ae114949aff4`, an ancestor of the active router
- Product-wave disposition: accepted and integrated
- Admission/integration owner: `ProjectScopedControl`
- Product capacity: at most one attempt/producer
- Mechanical evaluator: controller directly; no mechanical reviewer
- Semantic reviewer: one fresh independent combined
  integration/architecture/security reviewer
- Terminal state: `HOLD`

This lane supersedes all earlier PR #252 fixed source/base pins, fixed five-path conflict lists,
same-job continuation language, dirty-worktree patch preservation, and prior-worker reuse. It is
stable across future base movement.

No observed base SHA is stored in this packet. The live base becomes authority only inside one
immutable `pr252.latest-base-binding/v1` product-worker pre-start contract created by
`ProjectScopedControl` at atomic prepare/start.

## Admission binding

Before the worker starts, the controller/runtime atomically create and validate:

```json
{
  "format": "pr252.latest-base-binding/v1",
  "productAttemptId": "<unique attempt>",
  "repository": "777genius/agent-teams-ai",
  "pullRequestNumber": 252,
  "routerAuthoritySha": "81e79295e199bad0e6bf426537564ea7bc67dfcd",
  "canonicalHeadSha": "81e79295e199bad0e6bf426537564ea7bc67dfcd",
  "materializationSourceSha": "81e79295e199bad0e6bf426537564ea7bc67dfcd",
  "resolvedBaseSha": "<live PR base, exact lowercase 40 hex>",
  "orderedParentShas": ["81e79295e199bad0e6bf426537564ea7bc67dfcd", "<same resolvedBaseSha>"],
  "conflictPaths": ["<complete sorted actual conflict set>"],
  "focusedTestCommands": ["<exact deterministic focused command>"],
  "resolvedAt": "<RFC 3339>"
}
```

`ProjectScopedControl` resolves the live PR base exactly once for this binding. It then uses the
subscription runtime's builtin `worker-start-v1` and related execution primitives to materialize from
active router/canonical head `81e79295...`, applies the bound base as the ordered second parent,
freezes mechanically merged non-conflict bytes, derives the exact conflict set, records the focused
commands, and starts one fresh producer. The repository performs no raw lifecycle call.

The worker starts only when the complete contract exists and every equality holds. It cannot resolve
or change the base, move `HEAD`, reuse an earlier workspace, apply an old patch, fetch a different
source, alter the ordered parents, or widen the conflict set. Fast mode is prohibited.

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
15. the immutable pre-start contract
16. every exact `conflictPaths` path and the tests selected in `focusedTestCommands`

Do not recursively inspect unrelated projects, workers, repositories, research, evidence, provider
state, team state, or user/private directories.

## Exact producer scope

`conflictPaths` is the complete writable set. It comes from the actual attempt-bound ordered merge,
so this stable lane contains no path pin.

The producer may resolve merge markers inside those paths and nothing else. It must preserve every
mechanically merged non-conflict byte. It may not:

- add, remove, rename, move, reformat, or compile-repair another path;
- edit a neighboring barrel, index, test, fixture, generated output, docs file, config, dependency,
  lockfile, registry, or repository-temporary file unless it is itself in `conflictPaths`;
- replace the resolved tree with either whole parent;
- import an old resolution, patch carrier, rejected output, or prior attempt tree; or
- weaken a check, skip a test, hide a diagnostic, add a fallback, or perform unrelated cleanup.

If preservation requires a non-conflict edit, report a blocker and end `HOLD`.

## Both-behavior contract

For each conflict path, the producer identifies the behavior contributed by:

1. active router/canonical head `81e79295...`, including accepted product-wave behavior inherited
   from historical ancestor `eee2389f...`; and
2. the exact attempt `resolvedBaseSha`.

The resolution must preserve both. That includes contracts, validation, error semantics, persistence,
process/filesystem boundaries, UI behavior, task/team messaging semantics, and focused regressions
that either parent intentionally carries. Overlap is resolved deliberately at the smallest conflict
site.

The following are failures:

- taking `ours` or `theirs` wholesale without a path-specific semantic proof;
- silently deleting one behavior;
- weakening types, guards, authorization, containment, or error handling;
- preserving compilation while changing meaning;
- changing a test expectation instead of preserving the tested behavior;
- concealing an incompatibility behind optionality, a broad fallback, a compatibility shim, or a
  skipped case; or
- treating the successful mechanical merge of other paths as proof for a conflict.

When parent requirements are genuinely incompatible inside exact scope, the producer records the
conflict and does not guess.

## Focused tests

`ProjectScopedControl` selects deterministic `focusedTestCommands` after the actual conflicts are
known and before start. The set must cover:

- the nearest focused tests for every conflict path;
- the relevant behavior inherited from each parent;
- architecture or boundary ratchets directly implicated by a conflict; and
- any regression test whose semantics the manual resolution could change.

The producer may not replace, omit, broaden away, or reinterpret a selected command. A selected test
that cannot run is a failed gate, not a reason to change the command or install dependencies.

## Producer mechanical gates

Before result handoff, run and record all of:

1. full pre-start contract schema and equality validation;
2. fresh live-base comparison to `resolvedBaseSha` without rebinding;
3. canonical source and ordered-parent validation;
4. exact conflict-set and conflict-only diff proof;
5. byte equality for all mechanically merged non-conflict paths;
6. zero unmerged index entries;
7. zero unresolved merge markers;
8. every exact `focusedTestCommands` command;
9. `pnpm typecheck`;
10. `pnpm lint:fast:files -- <exact changed TypeScript/TSX conflict paths>`, when non-empty;
11. `pnpm exec prettier --check <exact changed text conflict paths>`;
12. `git diff --check`;
13. classified binary/symlink/NUL and conflict-marker scans over the exact conflict set;
14. classified secret/credential/auth/provider payload and private/user/home/real-project path scans
    over the exact conflict set and diff; and
15. proof that no install/fetch/update, real-project, team launch/provisioning, product terminal/smoke,
    provider/auth, raw lifecycle, other-repository, broad-docs, or Fast activity occurred.

Any command failure, moved/added/removed diagnostic, changed focused test count, unclassified match,
scope mismatch, or non-conflict byte drift fails the attempt.

## Self-review and producer result

After all gates pass, the producer rereads the complete resolved diff and self-reviews:

1. exact attempt/source/base/parents/conflict binding;
2. both-parent behavior preservation per conflict;
3. focused-test adequacy and results;
4. complete-tree integration coherence;
5. architecture and process-boundary compliance;
6. security, path, auth/provider, and data-exposure behavior;
7. exact scope/non-conflict immutability; and
8. every mechanical command, exit, count, scan classification, and remaining risk.

The result is one immutable runtime-owned record containing at least the attempt ID, canonical and
base SHAs, ordered parents, exact conflicts, exact resolved tree SHA, commands/exits, self-review,
P0/P1/P2 findings, blockers, and `terminalState: HOLD`.

This lane's specific runtime-owned result contract replaces the generic packet-template repository
`handoffPath`.

The producer writes no repository handoff manifest or evidence file, creates no commit, stages no
unrelated byte, starts no reviewer, calls no integration primitive, and authorizes no successor.

## Direct controller rerun

After producer `HOLD`, the controller—not another worker—compares the live base, freshly
materializes the exact producer tree, reruns the entire mechanical gate set through runtime execution
primitives, and directly decides pass/fail. It proves the rerun tree SHA equals the producer result
and records exact commands, exits, counts, and scans in controller/runtime state.

There is no separate mechanical reviewer, verifier, code reviewer, refill worker, or mechanical review
handoff. Failure ends the attempt `HOLD`.

## Independent combined semantic review

Only after the controller's direct mechanical pass and another base-equality check may one fresh
independent reviewer start. The reviewer is independent of router, producer, invalidated attempt
actors, and broker and has no repair/write/integration authority.

This single reviewer covers integration, architecture, security, and semantics. It inspects both
parents, every conflict resolution, the complete resolved tree, focused-test adequacy, producer
self-review, and controller mechanical evidence. It must detect whole-side selection, lost behavior,
scope escape, boundary violations, unsafe trust/path/process/data changes, hidden fallbacks, and
evidence inconsistencies.

Only exact `ACCEPT` with P0/P1/P2 `0/0/0`, bound to the same attempt/base/tree, permits broker
promotion. The reviewer ends `HOLD`. `REJECT` permits no integration and no automatic retry.

## Ordered broker integration

Immediately before promotion, the broker proves:

- the live PR base still equals attempt `resolvedBaseSha`;
- the PR head still equals canonical `81e79295...`;
- the independent review is exact `ACCEPT 0/0/0`;
- the accepted tree SHA equals the controller-rerun tree SHA; and
- no competing attempt or successor is active.

The broker creates only a true merge with exactly:

```text
parents[0] = 81e79295e199bad0e6bf426537564ea7bc67dfcd
parents[1] = attempt.resolvedBaseSha
tree       = exact independently accepted resolved tree
```

It promotes and pushes that merge with expected-old-head protection fixed to canonical head
`81e79295e199bad0e6bf426537564ea7bc67dfcd`. It then proves the remote PR head and GitHub PR head
OID equal the merge commit, GitHub's base OID still equals `resolvedBaseSha`, and GitHub mergeability
is resolved and non-conflicting for the exact pair.
`UNKNOWN`, `CONFLICTING`, moved base/head, parent/tree mismatch, one-parent/squash/patch-only
history, or push ambiguity is not success.

Git commit SHA is the primary provenance. Supporting runtime/broker captures are not repository
handoff manifests, and no hash-of-manifest bookkeeping is allowed.

## Drift and replacement

The binding is immutable. Later base drift never retargets a running, held, reviewed, or promotable
attempt. It invalidates only that attempt and all attempt-bound outputs.

After the invalidated attempt is terminal and capacity is empty, the controller may perform one new
atomic prepare/start with a new attempt ID and live base. It uses this same
`pr252.latest-base-binding/v1` format and `pr252-latest-base-sync-router-v1` packet. No docs/router
revision, source pin, fixed conflict list, patch continuation, or old worker is needed.

## Stop and HOLD

Stop on any router, head, base, attempt, full-SHA, parent-order, conflict-set, command, source, scope,
byte, index, marker, test, diagnostic, format, scan, self-review, independence, semantic, tree,
promotion, push, remote, or GitHub-proof mismatch.

The Phase 2 milestone and next phase remain blocked until the complete broker proof succeeds. Success
only releases that gate; it does not launch either phase action. Runtime owns execution primitives
only and never selects the DAG. End `HOLD`; launch no successor.
