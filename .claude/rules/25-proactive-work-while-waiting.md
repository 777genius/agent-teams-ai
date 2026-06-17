# Proactive Work While Waiting

When a long-running async task is in flight (PR review cycle, CI pipeline, deploy, image build, test suite, monitor stream) and the next step depends on its result, **proactively start any independent useful work in parallel** rather than passively watching status messages.

Sister rule to:
- Rule 22 (parallel-subagents-first) — about decomposing one task into parallel subtasks.
- Rule 23 (monitor-over-timered-watchers) — about how to *observe* state changes efficiently.
- Rule 24 (autonomous-execution-by-default) — about not asking for permission between agreed steps.

This rule extends those: don't just observe asynchronously — *act* on independent items while you wait.

## What counts as independent useful work

While waiting on an async signal:

1. **Adjacent fixes already queued** in TODO.md or Memora for the same domain.
2. **Stale-memory cleanup** for the current project tag — update any memory that the in-flight work has already partially superseded.
3. **Documentation that the in-flight work makes possible** — once the deploy verifies a fact, immediately codify it in the relevant doc rather than waiting for end-of-session.
4. **Investigation prep** for the most likely next-step branch points (e.g., if PR review will likely produce findings, pre-read the relevant source so you're warm).
5. **Drafting follow-up artefacts**: a follow-up PR's branch + early commits, a TODO entry's content, a CHANGELOG draft.

## What does NOT count (stop, do not pre-empt)

- **Speculative scope expansion.** Rule 19 (no self-driven simplifications/expansions) binds. Wait-time is not an excuse to invent new directions.
- **Destructive operations on the in-flight resource.** Don't `git rebase --onto` the branch the reviewer is reading, don't `docker compose down` the container the deploy script is still finishing with. Wait for the in-flight task to release the resource.
- **Mass refactors that block on the in-flight result.** If the answer is likely to invalidate the refactor, prepare the *plan* but don't write the code.
- **Anything that requires user judgment.** Confirm-first lists from rule 24 still apply.

## Pattern

```
# Bad — passively watching
[wait for monitor event]
[wait for monitor event]
[user prompts: "what are you doing?"]
[say "watching the monitor"]

# Good — independent useful work while watching
Monitor armed for verdict.
While waiting, drafting next-PR fixes (status-page ETA column + section reorder).
[monitor event arrives]
[address it]
[resume drafting]
```

## Coordination with monitors

When `Monitor` is armed for an async signal AND independent work exists:
- Don't pause your active workstream to read each monitor notification verbatim. Acknowledge tersely + continue.
- When the monitor notification IS the signal you were waiting for (verdict posted, deploy done, test failed), pause cleanly: finish the current sub-step, then act on the signal.
- If the signal can break the work-in-progress (e.g., a deploy completed and now a test rig is back online — your in-progress work depended on the rig being down), state the dependency and switch.

## Verification

After a session that involved waiting on async signals:

- Recall whether you started any independent work while the signals were pending.
- If you spent more than 2 monitor-tick cycles in passive observation with independent work available, name the missed proactivity opportunity in the session-wrap so future-you learns.
