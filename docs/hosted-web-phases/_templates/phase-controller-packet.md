# Phase <N>: <Outcome>

## Status and authority

- Status: `draft | ready | active | blocked | complete | superseded`
- Packet revision: `<phase-N-rM>`
- Parent plan commit: `<sha>`
- Predecessor integration commit: `<sha>`
- Predecessor evidence index SHA-256: `<hash>`
- Plan bundle commit: `<sha>`
- Phase start SHA: `<sha after serial bootstrap evidence>`
- Required ADR IDs: `<ids>`
- Explicit authorization: `<reference or pending>`

## Outcome

State one measurable phase result. Do not combine discovery, unrelated cleanup and later product scope.

## Inputs and inherited failures

- immutable base/predecessor SHA;
- frozen contracts and evidence IDs;
- accepted inherited failure IDs;
- reopened decisions and blocking unknowns.

## Non-goals

List later-phase behavior, deferred terminal scope and adjacent refactors that workers must not start.

## Definition of Ready

- [ ] predecessor freeze is complete;
- [ ] packet/evidence revisions match;
- [ ] host admission and project debt permit work;
- [ ] every lane has exclusive ownership;
- [ ] required test topology exists;
- [ ] rollback or feature gate is defined for behavior changes.
- [ ] child worktrees will be created only after the plan bundle and serial bootstrap evidence are in
      `phaseStartSha`.

## DAG and lane registry

| Lane     | Packet   | Dependencies | Evidence IDs | Estimate bucket   | Review pair       |
| -------- | -------- | ------------ | ------------ | ----------------- | ----------------- |
| `<lane>` | `<path>` | `<ids>`      | `<ids>`      | `<unique bucket>` | `<lane/reviewer>` |

Describe serial bootstrap, legal parallelism, integration order and freeze. One shared writer surface has
one integration owner.

Define unique lane slots and capacity epochs. A replacement attempt must name the slot and superseded
job; static templates must not create duplicate completed evidence work.

## Monitoring and intervention

Define freshness interval, useful-progress evidence, scope-overlap response, host load limit, debt
backpressure, stale-worker salvage and the conditions that stop new admission.

## Integration gate

For every lane require scope review, deterministic tests, negative controls, `git diff --check`, secret
scan, evidence-ID reconciliation and a clean integration attempt. State rejection and retry behavior.

## Definition of Done

- all evidence IDs are reviewed and adopted, rejected or explicitly deferred;
- required proof levels are met in the named topology;
- inherited/new failures are classified;
- bypass/old authority removal is proven where the phase changes behavior;
- rollback gate is exercised where required;
- decision and estimate registers are frozen;
- the next packet is materialized from this phase's evidence, not from the old master-plan assumptions.
