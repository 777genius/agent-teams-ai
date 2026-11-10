---
title: Git and Worktree Strategy – Agent Teams Docs
description: Decide when to use the main worktree, feature branches, or OpenCode worktree isolation for parallel agent work.
---

# Git and Worktree Strategy

Git gives Agent Teams the strongest review path: narrow diffs, branch visibility, task-scoped changes, and safer parallel work.

## Choose a strategy

| Strategy | Use when | Tradeoff |
| --- | --- | --- |
| Main worktree | Solo work, docs-only edits, or one teammate at a time | Simple, but parallel edits can collide |
| Feature branch | One team is working on one coherent change | Clean review target, but teammates still share files |
| Worktree isolation | Multiple OpenCode teammates may edit the same repo in parallel | Better isolation, but merge/review needs more discipline |

Start simple. Add worktree isolation when parallel edits are likely, not because every task needs a separate checkout.

## When to enable worktree isolation

Enable it for OpenCode teammates when:

- two or more teammates may edit the same repository at once
- a task may run formatters, code generators, or broad tests
- you want each teammate's branch and diff to stay separate
- the lead workspace is dirty and should not receive direct edits

Keep it off when:

- the task is read-only
- one teammate owns all edits
- the repo is not Git-tracked
- you need a runtime path that does not support this isolation mode

::: warning
Worktree isolation currently applies to OpenCode members and requires a Git-tracked project.
:::

## Branch hygiene

Before starting parallel work:

```bash
git status --short
git branch --show-current
```

Use a clean branch when possible. If the main worktree already has user changes, tell agents not to revert unrelated files and keep task scope narrow.

Recommended branch style:

```text
agent/<team-or-task>/<short-purpose>
```

Examples:

```text
agent/docs/mcp-guide
agent/review/task-log-filtering
agent/ui/code-review-polish
```

## Review flow

For isolated worktrees, review the teammate's diff before merging or applying changes back to the main workspace.

1. Confirm the task result comment names changed scope and verification.
2. Inspect the task diff in the review UI.
3. Ask for changes on the task if the diff touches unrelated files.
4. Approve only after tests or manual checks match the task risk.
5. Merge or apply changes deliberately.

Do not auto-merge worktree output just because the task is complete. Completion means the agent believes the work is ready for review.

## Conflict policy

Use this policy for parallel teams:

| Situation | Action |
| --- | --- |
| Two teammates edit the same file | Pause one task or make one owner responsible for integration |
| Generated files changed broadly | Require a comment explaining the generator and command |
| Main worktree has unrelated changes | Preserve them and review only task-owned changes |
| Worktree branch diverges | Rebase or merge manually after review, not inside a vague agent task |

## Task prompt example

```text
Implement the settings validation fix in your assigned worktree. Keep edits inside src/features/settings and focused tests. Do not touch provider auth or task storage. Post the test command and result before completing the task.
```

This prompt works because it names the allowed area, sensitive boundaries, and completion evidence.

## Related guides

- [Create a team](/guide/create-team)
- [Code review](/guide/code-review)
- [Team brief examples](/guide/team-brief-examples)
- [Runtime setup](/guide/runtime-setup)
