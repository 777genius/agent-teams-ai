# Parallel Subagents First

When work is decomposable into independent units, run them in parallel. Sequential execution is the exception, not the default.

## Rules

1. **Default to parallel.** Whenever a task has independent subtasks (research across multiple repos, multi-file edits in unrelated areas, multi-source documentation verification, per-service work), spawn parallel subagents or use the Agent tool with multiple concurrent invocations.
2. **Single-message parallel dispatch.** Send all independent tool calls in ONE message. Do not serialize agent invocations across multiple messages when they could run concurrently.
3. **Team agents for specialist perspectives.** When a task benefits from multiple specialist viewpoints (security audit, code review, test strategy, performance audit), spawn team agents in parallel. Aggregate their findings in the main session.
4. **Sub-agents for protected context.** When the work would dump >10 KB into the main context (large grep results, multi-file reads, exploratory research), delegate to a subagent that returns a summary.
5. **Sequential ONLY when necessary.** Two cases force sequential execution:
   - **Logical dependency**: agent B needs the output of agent A. Make this dependency explicit in the prompt.
   - **Consistency risk**: parallel edits to the same file or interconnected files would create merge conflicts. Document this rationale in the user-facing update.
6. **Quantify the speedup.** When choosing parallel over sequential, briefly state the expected speedup in the user-facing update ("running 15 explore agents in parallel — ~5× faster than serial walk").

## Anti-patterns

- "Let me first read file A, then file B, then file C" — when the three are independent. Read all three in one parallel batch.
- "I'll explore the codebase sequentially to be safe" — safety here is consistency, not slowness. If consistency isn't at risk, slowness is the bug.
- Spawning agents one at a time across multiple message turns when they could fire together.
- Calling a single Agent tool when a feature requires a code-reviewer + a security-auditor + a test-engineer perspective — that's three parallel calls, not one.

## Concurrent branches in the same repo (worktrees)

When the independent work is **concurrent branches in the same repo** (e.g. 2+ open PRs you're iterating on in parallel), use `git worktree` instead of `git checkout`-switching:

1. **One worktree per active branch.** Primary checkout stays on the first branch; subsequent branches each get their own worktree via `git worktree add <path> <branch>`.
2. **Symlink shared dependencies into each worktree.** `npm install`, `cargo fetch`, `pip install` etc. are fixed costs; multiplying them per worktree wastes time AND drifts dependency state. Symlink keeps one source of truth.
3. **One tooling instance handles all worktrees.** Build-watchers, formatters, autonomous reviewers, monitors — don't fork the tooling per worktree. They're stateless across branches (per-branch state lives in their own keying).
4. **Cleanup on merge.** After a branch merges, `git worktree remove <path>` and delete the local branch reference. Don't leave dead worktrees around.

Anti-patterns specific to worktrees:

- **`git checkout`-switching** between branches when worktrees exist — you'll dirty the wrong tree. Each worktree pins its own HEAD; use `cd` to switch directories, not `git checkout`.
- **Duplicating `npm install` per worktree** instead of symlinking.
- **Forking the tooling worker** per branch when one worker can handle many.

## Verification

After completing a task that involved spawning agents:

- Recall whether ANY pair of agents could have run in parallel but did not.
- If yes, name the missed parallelization opportunity in the change summary so future sessions learn.

## Relation to other rules

- **Rule 16 (sub-agents):** Rule 16 says *when* to use sub-agents; rule 22 says *how* (parallel-first).
- **Rule 19 (no self-driven simplifications):** Rule 19 forbids cutting quality; rule 22 forbids burning wall-clock on serial execution that could be parallel. Both are budget rules — one for tokens, one for time.
