# PR #252 latest-base sync controller packet

## Status and authority

- Current phase/node: `phase-02` / `PR252.LATEST_BASE_SYNC`
- Router revision: `pr252-latest-base-sync-router-v1`
- Canonical repository/PR: `777genius/agent-teams-ai#252`
- Historical accepted product-wave provenance:
  `eee2389f7ee9300df93ef02d92e9ae114949aff4`
- Active router/canonical head and canonical remote head:
  `81e79295e199bad0e6bf426537564ea7bc67dfcd`
- Product-wave relationship: the accepted product-wave commit is a historical ancestor of the active
  router/canonical head
- Product-wave disposition: accepted and integrated
- Remaining Phase 2 milestone blocker: latest-base sync only
- Next-phase blocker: latest-base sync only
- Admission/integration owner: `ProjectScopedControl`
- Runtime role: execution primitives only
- Terminal state: `HOLD`

This packet supersedes every earlier PR #252 source/base pin, same-job continuation, dirty-worktree
reuse contract, and fixed conflict-path assumption. It also supersedes the Phase 2 packet's earlier
candidate/product-launch wording as current execution authority without editing any `phase-02/`
path.

No currently observed base SHA is durable authority and none belongs in this packet. A branch name,
abbreviated SHA, stale GitHub observation, worker workspace, prior merge source, or router commit
cannot substitute for the live base bound by the atomic start contract.

The router author changes only the seven declared navigation/packet paths, performs no product or
Phase 2 packet edit, launches no worker, reviewer, broker action, or successor, and ends `HOLD`.

## Outcome

Once these exact seven paths are active controller authority, the DAG conditionally authorizes:

1. one atomic latest-base binding and at most one active bounded product merge-resolution producer;
2. direct controller rerun and evaluation of all mechanical gates, with no mechanical reviewer;
3. exactly one fresh independent combined integration/architecture/security semantic reviewer; and
4. on exact `ACCEPT`, broker creation, promotion, push, and GitHub proof of a true ordered
   two-parent merge.

Successful broker proof releases the latest-base gate. It does not itself perform the Phase 2
milestone review, advance the next phase, or launch a successor.

## Stable pre-start contract

Every product attempt uses exactly one internal format:
`pr252.latest-base-binding/v1`. It is an immutable runtime-owned product-worker pre-start contract,
not a repository file, handoff manifest, evidence manifest, or hash ledger.

For this gate, the specific no-repository-handoff rule in this packet and the execution index replaces
the generic packet-template `handoffPath`; producer and reviewer results remain runtime-owned.

Its logical shape is:

```json
{
  "format": "pr252.latest-base-binding/v1",
  "productAttemptId": "<non-empty unique attempt ID>",
  "repository": "777genius/agent-teams-ai",
  "pullRequestNumber": 252,
  "routerAuthoritySha": "81e79295e199bad0e6bf426537564ea7bc67dfcd",
  "canonicalHeadSha": "81e79295e199bad0e6bf426537564ea7bc67dfcd",
  "materializationSourceSha": "81e79295e199bad0e6bf426537564ea7bc67dfcd",
  "resolvedBaseSha": "<exact lowercase 40-hex live PR base commit>",
  "orderedParentShas": [
    "81e79295e199bad0e6bf426537564ea7bc67dfcd",
    "<the exact same resolvedBaseSha>"
  ],
  "conflictPaths": ["<sorted distinct actual conflict path>"],
  "focusedTestCommands": ["<exact focused command selected for these conflicts>"],
  "resolvedAt": "<RFC 3339 timestamp>"
}
```

The contract is valid only when:

1. the variable `resolvedBaseSha` is a full lowercase 40-hex commit SHA;
2. `routerAuthoritySha`, `canonicalHeadSha`, `materializationSourceSha`, and
   `orderedParentShas[0]` byte-equal active router commit
   `81e79295e199bad0e6bf426537564ea7bc67dfcd`;
3. `orderedParentShas` has exactly two entries in the declared order;
4. `orderedParentShas[1]` byte-equals `resolvedBaseSha`;
5. `conflictPaths` is the complete sorted, distinct, non-empty set produced by the attempt's ordered
   mechanical merge;
6. every focused command is deterministic, repository-local, and covers at least one conflict or a
   directly affected behavior; and
7. all fields were captured before the product worker began and are immutable afterward.

Git commit SHAs are primary provenance. The controller/runtime may additionally bind the attempt ID,
tree SHA, command results, timestamps, and reviewer disposition in runtime-owned records. Do not add
a repository handoff manifest or hash-of-manifest bookkeeping.

## Atomic prepare/start

`ProjectScopedControl` owns one atomic product-attempt prepare/start transition. The runtime supplies
only its builtin `worker-start-v1` and related execution primitives selected by the controller; this
repository does not implement or call a raw worker lifecycle. In that transition the controller:

1. proves the exact seven-path router is active authority and no product attempt is active, under
   review, or eligible for promotion;
2. proves PR #252's live head is exactly
   `81e79295e199bad0e6bf426537564ea7bc67dfcd`;
3. resolves the live PR base exactly once from canonical GitHub PR identity and requires one exact
   full commit object;
4. creates a unique `productAttemptId` and freezes that commit as `resolvedBaseSha`;
5. asks the runtime to materialize from active router/canonical head `81e79295...`, never from its
   historical product-wave ancestor, prior worker state, or the base;
6. asks the runtime to apply the bound base mechanically as ordered second parent, leaving conflicts
   unresolved and all non-conflicting bytes fixed;
7. records the exact actual conflict paths and controller-selected focused commands;
8. writes the complete immutable pre-start contract; and
9. starts at most one product producer against that prepared state.

These actions either succeed as one admission or start no worker. A missing/ambiguous GitHub response,
non-commit object, non-40-hex value, changed PR head, empty or inconsistent conflict set, materializer
failure, duplicate attempt, partial contract, or profile/scope mismatch ends `HOLD`.

The base is resolved once for binding. Later gates may read the then-live PR base solely to compare it
with `resolvedBaseSha`; they never update, re-resolve, or substitute the attempt binding.

## Product producer

The controller admits one bounded merge-resolution producer for the bound attempt. It is a fresh
product worker materialized from canonical `81e79295...`; no old job, same-job continuation, dirty
workspace, patch carrier, or prior attempt output is eligible. Fast mode is prohibited.

### Exact writable scope

The worker may change only the paths in `conflictPaths`. That list is generated from the actual
ordered merge, not authored in this packet. All mechanically merged non-conflict paths and their
bytes are read-only. The worker may not add, delete, rename, format, clean up, or compile-repair a
path outside the exact set. There is no neighboring-file, barrel, generated-output, docs, lockfile,
configuration, or temporary-repository exception.

If any conflict path, index entry, or merge status differs from the pre-start contract, the attempt is
invalid. The producer does not repair the contract or broaden scope.

### Required merge semantics

For every conflict, the producer must:

1. preserve the accepted/integrated Phase 2 product-wave behavior represented by
   historical ancestor `eee2389f7ee9300df93ef02d92e9ae114949aff4` and inherited by
   `canonicalHeadSha`;
2. preserve the relevant latest-base behavior represented by `resolvedBaseSha`;
3. combine overlapping behavior deliberately rather than select an entire side;
4. preserve mechanically merged non-conflicting behavior across the complete tree;
5. avoid compatibility shims, weakened validation, silent fallback, disabled tests, skipped cases,
   concealed deletions, or unrelated refactors used to make the merge pass;
6. update a test only when that test is itself an actual conflict path; and
7. leave zero unresolved conflict marker or unmerged index entry.

When the two behaviors cannot both be preserved inside actual conflict paths, the producer records a
blocking finding and returns `HOLD`; it does not expand scope.

### Focused and mechanical gates

Before handoff, the producer runs and records every gate below against the exact resolved tree:

1. validate the complete `pr252.latest-base-binding/v1` contract, attempt ID, canonical source,
   bound base, actual conflict set, and ordered parent equality;
2. compare the then-live PR base with `resolvedBaseSha`; inequality invalidates the attempt;
3. prove the diff is confined to `conflictPaths` and every non-conflicting path byte-equals the
   runtime's mechanical merge;
4. prove zero unmerged index entries and zero unresolved conflict markers;
5. run every exact `focusedTestCommands` entry, including coverage of both affected parent
   behaviors;
6. run `pnpm typecheck`;
7. run `pnpm lint:fast:files -- <exact changed TypeScript/TSX conflict paths>` when that set is
   non-empty;
8. run `pnpm exec prettier --check <exact changed text conflict paths>`;
9. run `git diff --check`;
10. classify the exact diff for binary/symlink content, secrets/credentials, auth/provider payloads,
    private/user/home/real-project paths, destructive behavior, and unresolved placeholders; and
11. prove no package/dependency install, fetch/update, real-project, team/provider, terminal/smoke,
    raw lifecycle, other-repository, or Fast activity occurred.

The producer then performs a complete self-review of behavior preservation, test adequacy,
architecture, security, scope, and all command results. It returns one immutable runtime-owned result
keyed by `productAttemptId` and the resolved Git tree SHA, with exact commands/exits, P0/P1/P2
findings, blockers, and `terminalState: HOLD`. It writes no repository handoff artifact, creates no
commit, starts no reviewer, and authorizes no integration.

## Direct controller mechanical gate

After a clean producer `HOLD`, `ProjectScopedControl` first compares the live base with the bound
`resolvedBaseSha`. On equality, it invokes runtime execution/evidence primitives itself to rerun
the complete mechanical gate list against a fresh materialization of the producer's exact resolved
tree.

The controller verifies exact command identity, exit codes, focused test counts, source/base/attempt
binding, conflict-only diff, non-conflict byte equality, formatting, diagnostics, index state, scans,
and resolved tree SHA. Producer evidence is not a substitute for this rerun.

There is no `prepare_verifier`, code-review worker, mechanical reviewer, second producer, or
worker-spawned reviewer at this node. The controller owns the decision. Any failure invalidates
promotion eligibility and ends this attempt `HOLD`.

## Independent integration/architecture/security semantic review

Only after the direct controller mechanical gate passes and the live base still equals the bound
commit may `ProjectScopedControl` admit exactly one fresh independent combined semantic reviewer.
The reviewer is independent of the router author, producer, every prior invalidated attempt actor,
and the broker. It receives the immutable binding contract, exact parent commits, exact conflict
set, accepted resolved tree SHA, producer self-review, and controller-owned mechanical evidence.

The reviewer has no edit, repair, stage, commit, merge, push, retry, replacement, rebind, or successor
authority. It is not a second mechanical reviewer. It independently decides:

1. whether each conflict resolution preserves both parent behaviors;
2. whether the complete tree is integration-coherent;
3. whether architecture remains compliant with Clean Architecture, DDD, SOLID, feature boundaries,
   and main/preload/renderer/shared responsibilities;
4. whether validation, trust boundaries, filesystem/process access, auth/provider data, and
   user/private data remain secure;
5. whether focused tests actually prove the affected behavior from both parents;
6. whether any whole-side selection, unrelated cleanup, behavior deletion, scope escape, hidden
   fallback, or evidence mismatch exists; and
7. whether the exact tree is safe for an ordered two-parent promotion.

The reviewer returns exactly one immutable runtime-owned `ACCEPT` or `REJECT` record bound to the
attempt ID, canonical SHA, resolved base SHA, conflict set, and resolved tree SHA, with P0/P1/P2
counts and `terminalState: HOLD`. Only `ACCEPT` with P0/P1/P2 `0/0/0` is promotable.
`REJECT` authorizes nothing; only the controller may later decide whether a bounded new attempt is
appropriate under this same stable packet.

## Base drift

The controller compares the live PR base with the bound commit:

1. before its direct mechanical rerun;
2. before reviewer admission;
3. immediately before broker merge construction and push; and
4. during post-push GitHub head/base/conflict proof.

Any inequality terminates and invalidates only that `productAttemptId`, its producer result, its
controller result, and any review. None can be replayed or retargeted. After the attempt is terminal
and capacity is clear, `ProjectScopedControl` may execute a new atomic prepare/start using the same
`pr252.latest-base-binding/v1` format and this same router revision. No packet edit, new docs
version, old job continuation, or source-pin update is required.

## Broker true-merge promotion and GitHub proof

After exact independent `ACCEPT`, the broker acts only on a fresh controller authorization. It
first proves the live base still equals `resolvedBaseSha` and the PR head still equals canonical
`81e79295...`. It then:

1. materializes the exact accepted reviewed tree;
2. creates one conventional merge commit with exactly the ordered parents
   `[81e79295e199bad0e6bf426537564ea7bc67dfcd, resolvedBaseSha]`;
3. proves the commit tree equals the reviewer-bound resolved tree SHA;
4. promotes and pushes that exact commit to the PR #252 head with expected-old-head protection
   fixed to `81e79295e199bad0e6bf426537564ea7bc67dfcd`;
5. proves the remote PR head equals the created merge commit; and
6. queries canonical GitHub PR #252 until mergeability is resolved, then proves its head OID equals
   the pushed merge commit, its base OID still equals `resolvedBaseSha`, and its mergeability is
   non-conflicting for that exact pair.

A one-parent, squash, patch-only, reversed-parent, octopus, whole-side, tree-mismatched, moving-base,
moving-head, force-substituted, unreviewed, unproven, or GitHub-`UNKNOWN`/`CONFLICTING` result is
not success and must not be represented as such.

The merge commit SHA, tree SHA, and ordered parent SHAs are primary provenance. Broker/runtime command
captures may provide supporting proof, but no repository handoff manifest or hash-of-manifest record
is created.

Only the complete pushed-head/base/GitHub proof releases `PR252.LATEST_BASE_SYNC`. The Phase 2
milestone and next phase then become eligible for separate controller decisions; this route launches
neither.

## DAG and capacity

```text
accepted/integrated Phase 2 product wave eee2389f...
  -> exact seven-path stable router 81e79295... becomes active canonical authority
    -> ProjectScopedControl atomic prepare/start
       resolve live PR base once -> pr252.latest-base-binding/v1
       materialize from 81e79295... -> actual conflict set -> ordered second-parent binding
      -> at most one bounded product producer
         actual conflicts only + both behaviors + focused/mechanical gates + self-review
        -> HOLD
          -> controller compares base and directly reruns all mechanical gates
             no separate mechanical reviewer
            -> exactly one independent integration/architecture/security semantic reviewer
              -> HOLD
                ACCEPT 0/0/0 -> broker rechecks binding
                  -> true merge [81e79295..., resolvedBaseSha]
                  -> exact reviewed tree -> promote -> push
                  -> remote-head equality + GitHub exact-pair non-conflict proof
                  -> release latest-base gate -> HOLD; no successor launch
                REJECT -> no promotion -> HOLD

base drift at any later gate
  -> invalidate only that product attempt
  -> same router + same format may atomically bind a future attempt after capacity clears
```

Product capacity is one attempt and one producer at a time. Review capacity is one combined semantic
reviewer only after controller mechanical acceptance. Documentation, runtime primitives, controller
checks, and broker actions do not consume product capacity and do not create DAG edges themselves.

## Exact router ownership

The router author owns exactly:

1. `docs/hosted-web-phases/EXECUTION_INDEX.json`
2. `docs/hosted-web-phases/README.md`
3. `docs/hosted-web-phases/START_HERE.md`
4. `docs/hosted-web-phases/phase-01/README.md`
5. `docs/hosted-web-phases/phase-01/controller-packet.md`
6. `docs/hosted-web-phases/phase-01/execution-dag.md`
7. `docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md`

Every product, test, Phase 2 packet, research, evidence, runtime, configuration, dependency,
lockfile, repository-index, and handoff path is read-only to this router. No format, link, generated
output, validator, compile-coherence, or cleanup exception exists.

## Stop policy and non-goals

Stop and end `HOLD` on router/source/head/base/attempt/parent/conflict-set drift; partial atomic
admission; extra/missing path; scope widening; old-workspace reuse; non-conflict byte mutation;
unresolved index or marker; behavior/test/architecture/security failure; unsafe or unclassified scan
match; incomplete self-review; mechanical reviewer creation; reviewer dependence or repair;
nonzero semantic findings; pre-acceptance integration; merge-tree/parent mismatch; push mismatch; or
missing/stale/unknown/conflicting GitHub proof.

Nothing here authorizes real-project access, agent-team launch/provisioning, task assignment, product
terminal/smoke/provider/auth flow, raw lifecycle calls, other repositories, broad docs work,
dependency install/update, Fast mode, router-author integration, or automatic successor launch.
Runtime owns execution primitives only; `ProjectScopedControl` owns the DAG. End `HOLD`.
