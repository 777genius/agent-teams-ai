# getTeamData Parallel Read Plan

## Goal

Reduce `team:getData` latency by parallelizing only the safe top-level read phase of `getTeamData()` without changing:

- `TeamData` payload shape
- message merge semantics
- dedup semantics
- warning semantics
- renderer/main truth boundaries
- launch/process reconciliation behavior

Primary target:

- repeated visible team detail refreshes

Not a target for this patch:

- new IPC endpoints
- renderer refresh changes
- new caches
- message payload slimming
- lower-pipeline refactors

## Why This Requires Extra Care

This touches a guarded hot zone:

- `main process / IPC / heavy team payload assembly`

Relevant guardrails:

- preserve state truth and reconciliation
- avoid heavier monolithic snapshot paths
- preserve observability
- prefer the smallest invariant-preserving change

Main failure modes to avoid:

- one async failure aborts the whole snapshot
- warning order becomes nondeterministic
- message merge order changes
- completion-time diagnostics become misleading
- side-effecting reads run concurrently with unrelated file-heavy reads
- naive parallelism creates enough disk contention to erase the perf gain
- the patch quietly assumes tests cover behavior they currently do not cover
- step wrappers silently mask wiring bugs because the wrapped closure does too much work
- nested settlement layers make the control flow harder to audit
- `presenceIndexPromise` rejection semantics change by accident
- shared mutable fallback objects leak across steps or tests
- diagnostics state is mutated from concurrent branches and becomes harder to audit
- queued heavy work starts reader I/O before a limiter slot is actually granted
- a queued heavy step records timing metadata at queue time instead of settle time
- fallback factories become mini control-flow hooks and start masking programming bugs
- warning text generation drifts from today because it becomes dynamic instead of literal

Relevant code:

- [src/main/services/team/TeamDataService.ts#L501](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamDataService.ts#L501)
- [src/main/ipc/teams.ts#L540](/Users/belief/dev/projects/claude/claude_team/src/main/ipc/teams.ts#L540)
- [src/renderer/store/index.ts#L938](/Users/belief/dev/projects/claude/claude_team/src/renderer/store/index.ts#L938)
- [src/main/services/team/TeamInboxReader.ts#L182](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamInboxReader.ts#L182)
- [agent-teams-controller/src/internal/processStore.js#L29](/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/processStore.js#L29)

## Hard Non-Goals

This patch must not:

- parallelize `readProcesses()`
- parallelize `resolveMembers()`
- parallelize `getMemberAdvisories(...)`
- parallelize `enrichMemberBranches(...)`
- change the post-load message pipeline
- change warning strings
- change warning order
- change any renderer store logic
- change any `InboxMessage` or `TeamData` semantics
- move concurrency into `TeamTaskReader` or `TeamInboxReader`

This patch must also not opportunistically fix adjacent issues such as:

- reusing `listInboxNames()` inside `getMessages()`
- introducing a single-team worker path for tasks
- caching lead-session directory listings

Those are separate patches.

Additional rule:

- keep all new concurrency orchestration local to `getTeamData()`

Why:

- moving concurrency into lower-level readers would widen the blast radius
- it would make it harder to reason about total filesystem pressure from this patch

## Dependency Graph

The patch must preserve this dependency graph exactly.

### Strict prerequisites

- `config` must complete before:
  - `extractLeadSessionTexts(config)`
  - any downstream assembly

Additional rule:

- if `config` is missing, `getTeamData()` must still throw before any read-phase step promises are created

Why:

- this preserves the current fast-fail behavior
- it avoids accidental background work for nonexistent teams

### Safe early-start paths

After `config`:

- `presenceIndexPromise`
- tasks
- inboxNames
- messages
- leadTexts
- sentMessages
- metaMembers
- kanbanState

### Assembly prerequisites

`resolveMembers(...)` requires all of:

- `config`
- `metaMembers`
- `inboxNames`
- `tasksWithKanban`
- final assembled `messages`

`tasksWithKanban` requires:

- `tasks`
- `kanbanState`
- `presenceIndexPromise`

`presenceIndexPromise` itself must preserve current semantics:

- it starts early
- it is awaited only after `tasksWithKanbanBase`
- if it rejects today, `getTeamData()` rejects

Rule:

- do not wrap, settle, catch, delay, or parallelize away that rejection behavior in this patch

### Explicit downstream-only paths

These must stay after assembly:

- `getMemberAdvisories(...)`
- `enrichMemberBranches(...)`
- `readProcesses(teamName)`

Why this section exists:

- the patch is only safe if dependency edges remain explicit
- parallelization work tends to hide dependency mistakes behind “it still compiled”

## Key Observations

### 1. `processes` is not a pure read

`readProcesses()` looks harmless, but `controller.processes.listProcesses()` can mark dead PIDs and synchronously rewrite `processes.json`.

Relevant code:

- [src/main/services/team/TeamDataService.ts#L874](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamDataService.ts#L874)
- [agent-teams-controller/src/internal/processStore.js#L29](/Users/belief/dev/projects/claude/claude_team/agent-teams-controller/src/internal/processStore.js#L29)

Rule:

- keep `processes` outside the parallel read phase

### 2. Some top-level readers already create their own fan-out

`TeamInboxReader.getMessages()` already performs bounded concurrent inbox reads.

Relevant code:

- [src/main/services/team/TeamInboxReader.ts#L14](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamInboxReader.ts#L14)
- [src/main/services/team/TeamInboxReader.ts#L182](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamInboxReader.ts#L182)

Implication:

- do not start every heavyweight reader at once
- control top-level heavy-step concurrency explicitly

### 3. `listInboxNames()` is duplicated work today

`getTeamData()` calls `listInboxNames()` directly, and `getMessages()` calls it again internally.

Relevant code:

- [src/main/services/team/TeamDataService.ts#L549](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamDataService.ts#L549)
- [src/main/services/team/TeamInboxReader.ts#L182](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamInboxReader.ts#L182)

Implication:

- phase 1 will still duplicate one inbox-directory listing
- that is acceptable for this patch
- do not widen the patch by coupling these readers

### 4. Warning order is currently deterministic

Current semantic order:

1. tasks
2. inbox names
3. messages
4. lead session texts
5. sent messages
6. member metadata
7. kanban state
8. runtime advisories
9. processes

Rule:

- preserve this order even if reads complete out of order

Additional rule:

- preserve warning presence and wording exactly
- do not deduplicate warnings in this patch

Additional note:

- `presenceIndexPromise` is intentionally not part of this warning sequence
- phase 1 must not introduce a new warning for presence loading

### 5. The lower pipeline is semantically sensitive

After the read phase, `getTeamData()` performs:

- message merge
- lead-session/live dedup
- session-id enrichment
- slash-result annotation
- kanban overlay
- member resolution

Rule:

- do not reorder, parallelize, or “clean up” this lower pipeline in phase 1

### 5a. `kanbanGc` is part of current diagnostics shape even though no GC runs here

`getTeamData()` currently records `mark('kanbanGc')` immediately after kanban load without performing garbage collection.

Relevant code:

- [src/main/services/team/TeamDataService.ts#L740](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamDataService.ts#L740)

Rule:

- keep this mark where it is in phase 1
- do not “clean it up” while touching perf code

Why:

- changing it mixes perf work with observability semantics
- it would make before/after slow-log comparison noisier

### 6. Existing tests do not cover the riskiest new behavior

Current coverage exercises many data semantics, but not:

- warning order under concurrent failures
- read-phase race behavior
- proof that `processes` stayed outside the parallel phase
- sync-throw fallback behavior for step wrappers

Rule:

- add those tests explicitly in this patch

Additional note:

- an existing test already asserts that `getTeamData()` remains read-only and does not invoke kanban garbage collection
- that invariant must stay green throughout this patch, not be replaced or weakened

## Safe Scope

### Safe to parallelize

After `config` loads successfully:

- `taskReader.getTasks(teamName)`
- `inboxReader.listInboxNames(teamName)`
- `inboxReader.getMessages(teamName)`
- `extractLeadSessionTexts(config)`
- `sentMessagesStore.readMessages(teamName)`
- `membersMetaStore.getMembers(teamName)`
- `kanbanManager.getState(teamName)`

### Explicitly keep serial

- `configReader.getConfig(teamName)`
- `presenceIndexPromise` setup logic
- all message merge/dedup/enrichment logic
- `resolveMembers(...)`
- `getMemberAdvisories(...)`
- `enrichMemberBranches(...)`
- `readProcesses(teamName)`

## Design Choice

### Preferred approach: two-level parallel read phase

After `config`, split the top read phase into:

#### Heavy group

Heavier file-system work:

- `getTasks`
- `getMessages`
- `extractLeadSessionTexts`

Run through a small limiter.

Recommended limit:

- `2`

Rules:

- use a fixed limit in phase 1
- do not make it adaptive
- do not make it platform-specific in phase 1

Why:

- `getMessages()` already fans out internally
- `getTasks()` can read many task files
- `extractLeadSessionTexts()` may scan directories and JSONL files
- fixed `2` is the most predictable low-risk choice before profiling

#### Light group

Lower-risk direct reads:

- `listInboxNames`
- `readMessages(sentMessages)`
- `getMembers(metaMembers)`
- `getState(kanban)`

Run immediately in parallel.

Important nuance:

- “light” here means “safe to start immediately”, not “guaranteed tiny”
- if later profiling shows one of these is expensive, that becomes a follow-up patch

### Why not one big `Promise.all`

- too easy to turn one step failure into whole-snapshot failure
- too easy to lose deterministic warnings
- too easy to create uncontrolled disk contention
- too easy to blur diagnostics and completion timing

### Safer fallback if confidence drops during implementation

If implementation reveals unexpected complexity, the fallback patch is:

- parallelize only the light group
- keep heavy steps serial

This fallback has lower upside but even lower risk:

- `🎯 7   🛡️ 10   🧠 3`

Rule:

- prefer shipping the light-group-only version over broadening the patch unsafely

## Step Wrapper Design

Do not use scattered `try/catch` blocks inside concurrent branches.

Introduce a small local helper inside `getTeamData()` or a tiny private helper in `TeamDataService`.

Preferred contract:

```ts
interface StepResult<T> {
  value: T;
  warning?: string;
  completedAt: number;
}

function startReadStep<T>(options: {
  label: string;
  createFallback: () => T;
  warningText?: string;
  load: () => Promise<T>;
}): Promise<StepResult<T>>
```

Required semantics:

- start the load immediately when invoked
- never reject outward for expected step failures
- convert both sync throws and async rejects into fallback + warning
- always record `completedAt`
- never mutate shared warning arrays internally
- keep fallback and warning text explicit at the callsite
- create fallback values only on failure

Additional rule:

- `warningText` should remain a static literal at each callsite
- do not compute warning text dynamically inside the helper

Why:

- this patch must preserve wording exactly
- dynamic warning construction would increase drift risk for no real benefit

Stronger rule:

- the wrapped `load` closure should be a thin direct call to one reader/service method
- do not put assembly logic inside the wrapper closure

Why:

- broad closures increase the chance that a programming bug gets silently turned into fallback + warning
- keeping closures thin confines masking behavior to the existing best-effort I/O boundary

Important constraint:

- keep this helper local to the hot path
- do not introduce a new shared generic abstraction in the same patch

Why:

- this is a surgical performance patch
- broad abstractions increase blast radius and review cost

Additional rule:

- the helper must not inspect or transform returned values

Additional rule:

- the helper must not mutate shared outer state such as `warnings` or `marks`

Why:

- any normalization inside the helper would increase the chance of semantic drift
- the helper should only control error capture and timing metadata

Additional rule:

- fallback values must be created per step callsite
- prefer `createFallback()` over passing a prebuilt object/array
- do not reuse one module-level empty array or one shared default object between steps

Additional rule:

- `createFallback()` must be synchronous, side-effect free, and trivial
- if `createFallback()` itself throws, treat that as a programming bug, not an expected degraded read failure

Why:

- arrays like `messages`, `tasks`, and `sentMessages` are later merged and sometimes mutated
- shared fallback identity would make accidental aliasing harder to spot in tests
- lazy fallback creation makes it harder to accidentally share the same object across successes and failures
- allowing fallback factories to become “smart” would widen the masking boundary beyond the current design intent

### Settlement rule

Because each step promise is designed to resolve with a `StepResult<T>` even on failure:

- prefer `Promise.all(stepPromises)` over `Promise.allSettled(stepPromises)`

Why:

- `Promise.allSettled` becomes redundant once the wrapper already settles failures
- a second settlement layer makes the control flow harder to reason about
- it increases the chance of accidentally swallowing a bug in the orchestration code itself

Additional rule:

- do not add per-step logging inside the helper in phase 1

Why:

- existing observability already relies on slow-log timing and final warnings
- extra step-local logs would change noise characteristics while the patch goal is latency reduction

## Diagnostics And Marks

Current `mark(...)` timestamps feed the slow log in [TeamDataService.ts#L804](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamDataService.ts#L804).

Do not lose that.

### Rule

- each step still needs a mark timestamp
- mark time should represent actual completion time
- not “when we finally consumed the result later”

### Practical approach

When a step settles, keep `completedAt` in the returned `StepResult`.

After `Promise.all(...)` completes, assign that timestamp into `marks[label]` from the main control flow.

Example:

- `marks.tasks = tasksStep.completedAt`
- `marks.messages = messagesStep.completedAt`

Stronger rule:

- do not mutate `marks` from inside concurrent branches

Why:

- the values would still be numerically correct, but the write path becomes harder to audit
- keeping all diagnostics writes in one deterministic place lowers review risk

Additional rule:

- do not synthesize marks for unfinished or skipped steps

Why:

- fake timestamps would make slow logs harder to trust
- missing marks should remain visible as `-1` via current `msSince(...)` behavior if something truly did not complete

### Important nuance

This changes interpretation slightly:

- before: marks reflected serial stage completion
- after: marks reflect “time since method start when this async read completed”

That is acceptable, but it should be documented near the helper or marks assignment in code comments.

## Warning Discipline

Warnings must remain deterministic.

Do not:

- call `warnings.push(...)` inside async branches

Instead:

1. collect each step result independently
2. append warnings after the parallel phase settles
3. append them in the same semantic order as today

Required final order:

1. `Tasks failed to load`
2. `Inboxes failed to load`
3. `Messages failed to load`
4. `Lead session texts failed to load`
5. `Sent messages failed to load`
6. `Member metadata failed to load`
7. `Kanban state failed to load`
8. `Member runtime advisories failed to load`
9. `Processes failed to load`

Phase 1 only changes how steps 1-7 are loaded, not their order.

## Exact Safe Execution Order

### Phase A - bootstrap

1. load `config`
2. create `warnings`
3. compute `changePresenceEnabled`
4. compute `logSourceSnapshot`
5. start `presenceIndexPromise` exactly as today

Important rule:

- do not wrap `presenceIndexPromise` in `startReadStep`
- do not convert a `presenceIndexPromise` rejection into fallback behavior
- do not move its await earlier than today

### Phase B - parallel read phase

Start these reads:

- heavy, limiter `2`:
  - tasks
  - messages
  - leadTexts
- light, direct:
  - inboxNames
  - sentMessages
  - metaMembers
  - kanbanState

Wait for all of them to settle.

Preferred implementation detail:

- create every step promise before awaiting any of them
- start light steps immediately
- start heavy steps immediately through the limiter
- only await results after all step promises exist
- use one final await point for the whole phase, not separate group awaits

Why:

- avoids accidental serial gaps
- makes the intended parallelism explicit
- prevents “light first, heavy later” drift from sneaking in during refactor

Additional rule:

- instantiate heavy-step promises in stable semantic order:
  - tasks
  - messages
  - leadTexts

Why:

- this makes limiter behavior deterministic
- it simplifies reasoning in tests that verify bounded heavy-step concurrency

Additional rule:

- do not create step promises inside array literals passed directly into `Promise.all`

Why:

- it hides creation order
- it makes breakpoint/debugging worse
- it increases the chance of accidental inline logic expansion

Additional rule:

- queued heavy steps must not execute any reader work before a limiter slot is granted

Why:

- otherwise the code may look bounded while still front-loading real filesystem work
- this is an easy place to accidentally defeat the limiter with an eager closure

Preferred composition:

- queue a thunk that starts the wrapped step only after the limiter grants a slot
- in other words, prefer `runHeavy(() => startReadStep(...))` over a shape that starts `startReadStep(...)` first and only limits an inner sub-call

Why:

- this makes “not started yet” observable in tests
- it avoids subtle eagerness around fallback creation or timing capture
- it keeps the limiter boundary explicit in code review

### Phase C - deterministic assembly

Using the resolved values:

1. append warnings in fixed order
2. initialize `messages` from the resolved inbox messages
3. append `leadTexts`
4. append `sentMessages`
5. run existing dedup logic unchanged
6. run existing session-id enrichment unchanged
7. run existing slash annotation unchanged
8. build `tasksWithKanbanBase`
9. await `presenceIndexPromise`
10. apply presence overlay
11. call `resolveMembers(...)`

Important rule:

- do not mutate the `messages` array during the parallel read phase

Important rule:

- preserve the current `presenceIndexPromise` await point
- it must still happen after `tasksWithKanbanBase` exists and before presence overlay is applied

Additional rule:

- keep local variable names close to the current implementation where practical

Why:

- smaller diffs reduce review risk in a fragile hot path
- easier diff-reading improves confidence that only await ordering changed

### Phase D - unchanged lower phase

Keep this serial in phase 1:

1. `getMemberAdvisories(...)`
2. `enrichMemberBranches(...)`
3. `readProcesses(teamName)`

Important rule:

- `runtimeAdvisories` warning must still precede `processes`
- `processes` warning must still be last

Additional rule:

- if phase 1 reveals that `readProcesses()` is also a measurable bottleneck, do not “just parallelize it”
- handle it in a separate plan because it is a reconcile-like path

## Implementation Notes

### 1. Use a tiny local limiter, not a new dependency

Do not add a library.

Either:

- reuse a tiny local `mapLimit` style pattern
- or add a minimal local limiter helper inside `TeamDataService`

The helper should be boring and obvious.

### 2. Preserve fallback defaults exactly

Defaults today:

- tasks: `[]`
- inboxNames: `[]`
- messages: `[]`
- leadTexts: `[]`
- sentMessages: `[]`
- metaMembers: `[]`
- kanbanState: default empty state
- processes: `[]`

Do not change any of these defaults.

Stronger rule:

- instantiate array fallbacks as fresh literals at each step callsite
- instantiate the empty `kanbanState` fallback as a fresh object literal at its callsite

Why:

- it prevents accidental aliasing if later code mutates a returned fallback object
- it keeps tests honest when assertions depend on reference isolation

### 3. Keep `presenceIndexPromise` untouched

It already starts early and is gated correctly.

Changing it would add correctness risk with little payoff.

Stronger rule:

- preserve both success and failure semantics exactly
- if `presenceIndexPromise` rejects today, the method should still reject after the same downstream point

Why:

- silently degrading change-presence data would be a correctness change, not just a perf change

### 4. Do not mix adjacent optimizations into this patch

Specifically do not combine:

- inbox-name reuse between `listInboxNames()` and `getMessages()`
- task reader worker-path changes
- lead-session dir listing cache

Why:

- mixed patches are harder to reason about
- perf attribution gets worse
- rollback gets harder

### 5. Prefer the lowest-risk first wrapper conversion during implementation

If doing the implementation incrementally, the first serial wrapper conversion should be one of:

- `membersMetaStore.getMembers(teamName)`
- `sentMessagesStore.readMessages(teamName)`

Avoid using `getMessages()` or `extractLeadSessionTexts(config)` as the first wrapper-conversion step.

Why:

- they are semantically denser and more file-heavy
- starting with a lighter reader makes it easier to verify the wrapper boundary before concurrency is introduced

### 6. Do not add committed benchmark scaffolding in this patch

If extra timing is needed during implementation:

- use temporary local instrumentation or existing slow-log output
- remove any temporary timing helpers before committing

Why:

- the patch goal is a surgical hot-path change, not a new profiling framework
- leaving ad hoc benchmark scaffolding behind would increase maintenance noise

## Edge Cases

### 1. `messages` fail but `leadTexts` succeed

Expected:

- final `messages` still contains `leadTexts` and `sentMessages`
- warning includes `Messages failed to load`

### 2. `leadTexts` fail but inbox messages succeed

Expected:

- final `messages` remains valid without lead session history
- warning includes `Lead session texts failed to load`

### 3. `kanbanState` fails

Expected:

- tasks still load
- empty kanban fallback is used
- warning order remains stable
- renderer still sees safe fallback state

### 4. `metaMembers` fail

Expected:

- resolver still works from config + inbox names + messages
- warning includes `Member metadata failed to load`

### 5. One heavy read is very slow

Expected:

- light reads are not blocked from starting
- heavy reads are bounded and do not all pile up at once

### 6. Duplicate inbox-dir reads happen concurrently

Expected:

- this is acceptable in phase 1
- no semantic change occurs
- this should not be “optimized away” inside the same patch

### 7. `processes` marks a dead runtime and writes `processes.json`

Expected:

- this still happens
- it still happens outside the parallel read phase

### 8. A step throws synchronously before returning a promise

Expected:

- the step wrapper converts it into fallback + warning
- `getTeamData()` still returns a partial snapshot

### 9. A heavy step finishes before a light step

Expected:

- marks reflect actual completion times
- warnings remain in semantic order
- assembly order remains unchanged

### 10. A bug occurs in orchestration code outside a step wrapper

Expected:

- it should still surface as a normal test/runtime failure
- it must not be hidden behind generic fallback behavior

Why this matters:

- the wrapper is only meant to preserve current best-effort reader semantics
- it is not meant to hide mistakes in assembly code

### 11. `presenceIndexPromise` rejects

Expected:

- `getTeamData()` still rejects
- no new warning is added
- the reject point remains after `tasksWithKanbanBase` construction, as today

Why this matters:

- changing this would alter correctness semantics for task change presence
- that is outside the scope of a safe latency patch

### 12. Heavy-step limiter accidentally serializes everything

Expected:

- light steps still start immediately
- at least two heavy steps may be in flight before the first one resolves

Why this matters:

- a broken limiter implementation can silently collapse back to serial behavior while tests still pass

### 13. A heavy step is queued behind the limiter and throws synchronously when finally started

Expected:

- the wrapper still converts it into fallback + warning
- the limiter slot is released
- downstream heavy steps can still run

Why this matters:

- queued execution introduces a second place where sync throws can happen
- the plan should be explicit that the limiter cannot leak capacity on failure

### 14. A queued heavy step has not started yet

Expected:

- its underlying reader has not been called
- it has not produced a warning
- it has not stamped `completedAt`

Why this matters:

- otherwise the limiter may only be cosmetically bounding concurrency
- timing diagnostics would become misleading if queue time and completion time are confused

### 15. `createFallback()` is evaluated

Expected:

- it is evaluated only after the corresponding load fails
- it does not perform I/O or mutate shared state
- if it throws, the test should fail rather than being silently degraded

Why this matters:

- fallback factories are part of the masking boundary
- making them “smart” would quietly widen the behavior of the patch

## Testing Plan

Add focused tests in [TeamDataService.test.ts](/Users/belief/dev/projects/claude/claude_team/test/main/services/team/TeamDataService.test.ts).

### Preferred test technique

Prefer explicit deferred promises over fake timers for read-phase ordering tests.

Why:

- fake timers tend to couple tests to implementation details like `setTimeout`
- deferred promises make start-order and release-order assertions clearer
- the existing test file already uses direct promise orchestration patterns successfully

### Required tests

1. Parallel read phase does not abort full `getTeamData()` when one step fails.

2. Warning order remains the same as before even when failures resolve out of order.

3. `messages` merge order remains unchanged:
   - inbox
   - plus leadTexts
   - plus sentMessages
   - then current dedup/enrichment behavior

4. `resolveMembers()` is still called with the same effective inputs.

5. `readProcesses()` still runs after the top read phase and still populates `processes`.

6. `kanban` fallback remains safe when kanban read fails.

7. `leadTexts` success still contributes messages even if inbox read fails.

8. slow diagnostics do not crash when marks are produced from async completion times.

9. a step that throws synchronously still degrades to fallback + warning.

10. `processes` remains outside the parallel read phase.

11. orchestration still fails normally if an error is thrown after step resolution and outside the wrapper boundary.

12. light steps start even while heavy steps are still blocked.

13. heavy-step limiter still allows bounded overlap and does not collapse to fully serial execution.

14. `presenceIndexPromise` rejection semantics remain unchanged.

15. no concurrent branch writes directly into `warnings` or `marks`.

16. the existing read-only invariant for `getTeamData()` remains intact and kanban GC is still not invoked from this path.

17. the third heavy step does not call its underlying reader before one of the first two heavy steps settles.

18. a queued heavy step does not stamp `completedAt` before it actually settles.

19. missing-team fast-fail still happens before any read-phase step starts.

20. fallback creation happens only on failure and does not itself become a hidden degraded path.

### Nice-to-have tests

1. prove heavy-group limiter behavior with deferred promises
2. prove warnings do not depend on completion order
3. prove light steps can finish before heavy ones without changing assembly order
4. prove heavy-step start order remains deterministic under the limiter
5. prove queued heavy-step failure releases limiter capacity for the next heavy step
6. prove fallback arrays/objects are not shared across unrelated step results
7. prove missing-team fast-fail still happens before any read-phase step starts
8. prove fallback creation is lazy and does not run on successful steps

### Testing note

Current tests exercise many `getTeamData()` semantics, but they do not currently prove:

- warning order
- read-phase race behavior
- serial `processes`

These tests must be added explicitly in this patch.

Additional testing rule:

- at least one new test should assert start order, not only final output

Why:

- output-only assertions can miss accidental serialization or accidental over-parallelization

## Rollout Strategy

### Phase 1

Implement only:

- local step wrapper
- small local heavy-step limiter
- top-level parallel read phase
- deterministic warning collection
- explicit tests for warning order and serial `processes`
- explicit tests for bounded heavy overlap and immediate light-step start
- explicit test for unchanged `presenceIndexPromise` rejection behavior

### Recommended implementation sequence

1. Add the local `StepResult<T>` shape and `startReadStep(...)` helper without changing behavior yet.
2. Move one low-risk light read to the helper pattern and keep it serial to verify the wrapper boundary stays thin.
3. Introduce the local heavy limiter with a tiny focused test before wiring all heavy steps through it.
4. Convert the full top read phase into:
   - light steps started directly
   - heavy steps started via the limiter
5. Keep warning collection and mark assignment outside the wrappers and outside concurrent branches.
6. Re-run the lower assembly with local variable names as close to the current code as practical.
7. Add the ordering and failure-mode tests last, after the implementation shape stabilizes.

Why this order:

- it keeps each transition auditable
- it makes it easier to catch accidental semantic drift before the whole method is reshaped

Additional rule:

- do not combine the helper-contract change and the full concurrency rewrite in one blind edit

Why:

- separating those transitions makes review of semantic drift much easier

### Phase 2 only if needed later

- optional `getLeadSessionJsonlPaths()` cache
- optional inbox-name reuse between `listInboxNames()` and `getMessages()`
- optional broader lower-phase parallelization

## Success Criteria

The patch is successful if all are true:

1. `TeamData` payload shape is unchanged
2. existing tests pass
3. new warning-order and race tests pass
4. `typecheck` passes
5. targeted `getTeamData` latency improves on repeated refreshes
6. no warning-order drift
7. no changes to dedup or renderer-visible semantics

## Areas With Lower Confidence

### 1. Best heavy-step limiter value

Confidence: medium.

Why:

- `2` is the safest educated default
- it is not backed by real profiling data yet

Decision:

- use `2` in phase 1
- tune only after measurement

### 2. Real contention impact of concurrent `getMessages()` plus `extractLeadSessionTexts()`

Confidence: medium.

Why:

- both touch team filesystem data
- one already does internal fan-out

Decision:

- keep the heavy group bounded
- do not add more heavy steps to it in phase 1

### 3. Diagnostic interpretation shift

Confidence: medium-high.

Why:

- marks will no longer describe a strictly serial stage pipeline
- but they remain operationally useful

Decision:

- preserve labels
- store actual completion times
- document the interpretation shift

### 4. Perf upside size

Confidence: medium-high.

Why:

- the current serial top read phase is clearly a bottleneck candidate
- exact gains still depend on filesystem behavior and team size

Decision:

- keep the patch narrow
- verify with targeted timings before any broader refactor

### 5. Exact wrapper boundary

Confidence: medium.

Why:

- too broad a wrapper masks bugs
- too narrow a wrapper creates repetitive code and inconsistent fallback handling

Decision:

- wrap only the direct reader/service call
- keep all merge/assembly logic outside the wrapper

### 6. `presenceIndexPromise` semantics

Confidence: medium.

Why:

- it starts early but is awaited later
- it currently rejects the whole method instead of degrading to warning
- it is easy to accidentally “improve” this while introducing wrappers

Decision:

- preserve current reject semantics exactly
- add a regression test explicitly for this

### 7. Test strength for concurrency behavior

Confidence: medium.

Why:

- concurrency tests often pass while failing to prove the intended scheduling shape
- the current suite has very limited ordering-specific coverage

Decision:

- use explicit deferred promises
- assert both start order and completion-order independence

### 8. Limiter implementation correctness

Confidence: medium.

Why:

- small limiters are easy to get almost right while still leaking capacity or starting work eagerly
- that kind of bug can preserve output correctness while eliminating the perf gain

Decision:

- keep the limiter tiny and local
- verify queued-failure release behavior in tests
- verify that the third heavy step does not start before one of the first two settles

### 9. Wrapper and limiter composition

Confidence: medium.

Why:

- the code can look “limited” while still eagerly starting reader work
- this is one of the easiest places to lose the intended perf behavior without breaking output tests

Decision:

- prefer queuing a thunk that starts `startReadStep(...)` only after slot acquisition
- add a test that asserts the third heavy reader has not been called while both slots are occupied

### 10. Fallback-factory discipline

Confidence: medium.

Why:

- `createFallback()` looks harmless, but it is part of the same masking boundary as the wrapper
- if it grows side effects or branching logic, the patch stops being a narrow perf change

Decision:

- keep fallback factories as trivial literals/object constructors
- keep warning text static at the callsite
- let thrown fallback-factory errors surface as programming bugs

## Residual Risk

Even after this patch, the architecture remains sensitive because:

- `team:getData` still assembles a large monolithic snapshot
- `messages[]` is still a hot payload
- first-open cost still exists
- `processes` remains a reconcile-like read/write path

This patch should therefore be treated as:

- a safe latency reduction
- not a final architectural solution
